import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, type DecidedBy, type Project, type UsageMeter } from "@windtunnel/core";

/** A small multiple-choice decision: which control a renamed button became, why a run failed. */
export interface Question {
  /** selector, triage… */
  kind: string;
  /** The question, in a sentence. */
  ask: string;
  /** What the answer depends on, a few short lines. Secrets are removed before it leaves the machine. */
  context: string[];
  /** Option id → what choosing it means. */
  options: Record<string, string>;
}

export interface Answer {
  /** The option chosen; undefined when the question goes to the agent. */
  choice?: string;
  confidence: number;
  by: DecidedBy;
  ms: number;
  /** Why it went to the agent (no key, budget spent, unsure, error). */
  note?: string;
}

/** A small, fast model called with a key we configure, never the user's agent subscription. */
export interface LevelOne {
  readonly name: "spark" | "jev";
  ask(question: Question, signal: AbortSignal): Promise<{ choice: string; confidence: number; inputTokens?: number; outputTokens?: number; usd?: number }>;
}

const LEVEL_ONE_TIMEOUT_MS = 20_000;

/**
 * Decides at the cheapest level that is sure enough: rules (plain code), then Muse Spark or
 * Jev when a key is set and the job's budget allows, then the agent (a pending decision it
 * answers with windtunnel_decide).
 */
export class Decider {
  readonly levelOne?: LevelOne;
  private readonly threshold: number;
  private readonly budgetUsd: number;
  private readonly meter?: UsageMeter;
  private readonly secrets: string[];

  constructor(options: { levelOne?: LevelOne; threshold?: number; budgetUsd?: number; meter?: UsageMeter; secrets?: string[] }) {
    this.levelOne = options.levelOne;
    this.threshold = options.threshold ?? 0.8;
    this.budgetUsd = options.budgetUsd ?? 0.5;
    this.meter = options.meter;
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 6);
  }

  /** From the config and the environment: WINDTUNNEL_DECIDER overrides `decider.use` (rules, spark, jev, auto). */
  static forProject(project: Project, meter?: UsageMeter, env: NodeJS.ProcessEnv = process.env): Decider {
    const { decider, budget, users, db } = project.config;
    const use = env.WINDTUNNEL_DECIDER ?? decider.use;
    if (!["auto", "rules", "spark", "jev"].includes(use)) throw new ConfigError(`WINDTUNNEL_DECIDER must be auto, rules, spark or jev (got ${use})`);
    let levelOne: LevelOne | undefined;
    const spark = env.MODEL_API_KEY;
    const jev = env.OPENROUTER_API_KEY;
    if (use === "spark" || (use === "auto" && spark)) {
      if (!spark) throw new ConfigError("decider spark needs MODEL_API_KEY (a Meta Model API key)");
      levelOne = new MuseSpark(decider.spark.baseUrl, decider.spark.model, spark);
    } else if (use === "jev" || (use === "auto" && jev)) {
      if (!jev) throw new ConfigError("decider jev needs OPENROUTER_API_KEY");
      levelOne = new Jev(decider.jev.baseUrl, decider.jev.model, jev);
    }
    return new Decider({
      levelOne,
      threshold: decider.confidence,
      budgetUsd: budget.usd,
      meter,
      secrets: [
        ...Object.values(users).map((u) => u.password),
        ...(db?.kind === "postgres" ? [db.url] : []),
        ...[spark, jev].filter((k): k is string => !!k),
      ],
    });
  }

  /** Counts a decision plain code made on its own. */
  async record(kind: string, by: DecidedBy = "rules"): Promise<void> {
    await this.meter?.record({ kind: "decision", name: kind, ms: 0, by }).catch(() => undefined);
  }

  /** `rules → agent`, or with the Level 1 model in use between them. */
  get level(): string {
    return this.levelOne ? `rules → ${this.levelOne.name === "spark" ? "Muse Spark" : "Jev"} → agent` : "rules → agent";
  }

  /** The same, in words: `rules, then Muse Spark, then you`. */
  get chain(): string {
    return this.levelOne ? `rules, then ${this.levelOne.name === "spark" ? "Muse Spark" : "Jev"}, then you` : "rules, then you";
  }

  /**
   * `rules` is plain code's own answer, if it has one: used when its confidence clears the
   * threshold, else passed on as a hint.
   */
  async decide(question: Question, rules?: { choice: string; confidence: number }): Promise<Answer> {
    const started = Date.now();
    const done = async (answer: Omit<Answer, "ms">, usage: { inputTokens?: number; outputTokens?: number; usd?: number } = {}) => {
      const full = { ...answer, ms: Date.now() - started };
      await this.meter?.record({ kind: "decision", name: question.kind, ms: full.ms, by: full.by, ...usage }).catch(() => undefined);
      return full;
    };
    if (rules && rules.confidence >= this.threshold && rules.choice in question.options) {
      return done({ choice: rules.choice, confidence: rules.confidence, by: "rules" });
    }
    let note = this.levelOne ? undefined : "no Level 1 model configured (set MODEL_API_KEY or OPENROUTER_API_KEY)";
    if (this.levelOne) {
      const spent = this.meter?.totals().usd ?? 0;
      if (spent >= this.budgetUsd) {
        note = `the job's Level 1 budget ($${this.budgetUsd}) is spent`;
      } else {
        const asked = Date.now();
        try {
          const reply = await this.levelOne.ask(this.redact(question), AbortSignal.timeout(LEVEL_ONE_TIMEOUT_MS));
          const usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, usd: reply.usd };
          if (reply.choice in question.options && reply.confidence >= this.threshold) {
            return done({ choice: reply.choice, confidence: reply.confidence, by: this.levelOne.name }, usage);
          }
          // Not sure enough: the spend still counts.
          await this.meter?.record({ kind: "decision", name: `${question.kind}:unsure`, ms: Date.now() - asked, ...usage }).catch(() => undefined);
          note = `${this.levelOne.name === "spark" ? "Muse Spark" : "Jev"} was unsure (${reply.choice}, ${reply.confidence.toFixed(2)})`;
        } catch (err) {
          note = `${this.levelOne.name} failed: ${(err as Error).message.slice(0, 200)}`;
        }
      }
    }
    return done({ confidence: rules?.confidence ?? 0, by: "agent", note });
  }

  /** Removes passwords, keys and connection strings before a question leaves the machine. */
  redact(question: Question): Question {
    const clean = (text: string) => {
      let out = text
        .replace(/\b(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/\S+/gi, "[url]")
        .replace(/\bBearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
        .replace(/\b(sk|pk|rk)[-_][\w-]{12,}/g, "[key]");
      for (const s of this.secrets) out = out.split(s).join("[redacted]");
      return out;
    };
    return {
      ...question,
      ask: clean(question.ask),
      context: question.context.map(clean),
      options: Object.fromEntries(Object.entries(question.options).map(([k, v]) => [k, clean(v)])),
    };
  }
}

const SYSTEM = [
  "You make one small decision for a web app testing tool.",
  "Pick the option the context supports. Report confidence from 0 to 1: below 0.8 when the context does not settle it.",
  'Reply with JSON only: {"choice": "<option id>", "confidence": <number>}.',
].join(" ");

function prompt(question: Question): string {
  return [
    question.ask,
    "",
    "Context:",
    ...question.context.map((c) => `- ${c}`),
    "",
    "Options:",
    ...Object.entries(question.options).map(([id, label]) => `- ${id}: ${label}`),
  ].join("\n");
}

/** Reported Muse Spark 1.3 prices, USD per 1M tokens (input, output); check Meta's pricing page. */
const SPARK_PRICE = { input: 1.25, output: 4.25 };

/** Muse Spark through Meta's OpenAI-compatible chat completions, with a JSON schema for the answer. */
export class MuseSpark implements LevelOne {
  readonly name = "spark" as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly key: string;

  constructor(baseUrl: string, model: string, key: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.key = key;
  }

  async ask(question: Question, signal: AbortSignal) {
    const ids = Object.keys(question.options);
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: prompt(question) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "decision",
            strict: true,
            schema: {
              type: "object",
              properties: { choice: { type: "string", enum: ids }, confidence: { type: "number" } },
              required: ["choice", "confidence"],
              additionalProperties: false,
            },
          },
        },
        reasoning_effort: "minimal",
        // Reasoning tokens count here too.
        max_completion_tokens: 1024,
      }),
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`HTTP ${response.status}${body.error?.message ? `: ${body.error.message}` : ""}`);
    const parsed = JSON.parse(body.choices?.[0]?.message?.content ?? "{}") as { choice?: string; confidence?: number };
    const inputTokens = body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? body.usage?.output_tokens ?? 0;
    return {
      choice: String(parsed.choice ?? ""),
      confidence: clamp(Number(parsed.confidence ?? 0)),
      inputTokens,
      outputTokens,
      usd: (inputTokens * SPARK_PRICE.input + outputTokens * SPARK_PRICE.output) / 1_000_000,
    };
  }
}

/** Jev through OpenRouter's Decisions API: a choice question with a probability per option. */
export class Jev implements LevelOne {
  readonly name = "jev" as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly key: string;

  constructor(baseUrl: string, model: string, key: string) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.key = key;
  }

  async ask(question: Question, signal: AbortSignal) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        state: question.context.join("\n"),
        questions: { decision: { type: "choice", instructions: question.ask, criteria: question.options } },
      }),
      signal,
    });
    const body = (await response.json().catch(() => ({}))) as {
      answers?: { decision?: { choice?: string; confidence?: number } };
      usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(`HTTP ${response.status}${body.error?.message ? `: ${body.error.message}` : ""}`);
    const answer = body.answers?.decision;
    return {
      choice: String(answer?.choice ?? ""),
      confidence: clamp(Number(answer?.confidence ?? 0)),
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
      usd: body.usage?.cost,
    };
  }
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// ---- Decisions handed back to the agent ----

export const DECISIONS_DIR = join("cache", "decisions");

export interface PendingDecision<P = unknown> {
  id: string;
  created: string;
  question: Question;
  /** Plain code's best guess, if it had one. */
  hint?: string;
  /** Why it came to the agent. */
  note?: string;
  /** What answering it does (kind-specific). */
  payload: P;
  /** Free-form answers allowed besides the option ids (e.g. a locator for selector decisions). */
  freeForm?: string;
  answered?: { at: string; answer: string; result: string };
}

/** `.windtunnel/cache/decisions/<id>.json` */
export class DecisionStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, DECISIONS_DIR);
  }

  async add<P>(decision: Omit<PendingDecision<P>, "id" | "created">): Promise<PendingDecision<P>> {
    await mkdir(this.dir, { recursive: true });
    const full: PendingDecision<P> = { id: `d${randomBytes(2).toString("hex")}`, created: new Date().toISOString(), ...decision };
    await writeFile(join(this.dir, `${full.id}.json`), `${JSON.stringify(full, null, 2)}\n`);
    return full;
  }

  async get(id: string): Promise<PendingDecision> {
    if (!/^d[0-9a-f]{4}$/.test(id)) throw new ConfigError(`bad decision id: ${id}`);
    const text = await readFile(join(this.dir, `${id}.json`), "utf8").catch(() => {
      throw new ConfigError(`no decision ${id} (windtunnel_decide with no id lists the open ones)`);
    });
    return JSON.parse(text) as PendingDecision;
  }

  async save(decision: PendingDecision): Promise<void> {
    await writeFile(join(this.dir, `${decision.id}.json`), `${JSON.stringify(decision, null, 2)}\n`);
  }

  /** Open decisions, oldest first. */
  async open(): Promise<PendingDecision[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.dir, f), "utf8")) as PendingDecision));
    return all.filter((d) => !d.answered).sort((a, b) => a.created.localeCompare(b.created));
  }
}

/** A pending decision as the agent sees it. */
export function formatDecision(d: PendingDecision): string {
  return [
    `decision ${d.id} (${d.question.kind}): ${d.question.ask}`,
    ...d.question.context.map((c) => `  ${c}`),
    "  options:",
    ...Object.entries(d.question.options).map(([id, label]) => `    ${id}: ${label}`),
    ...(d.freeForm ? [`    or: ${d.freeForm}`] : []),
    ...(d.hint ? [`  best guess: ${d.hint}`] : []),
    `  answer with windtunnel_decide id=${d.id} answer=<option>`,
  ].join("\n");
}

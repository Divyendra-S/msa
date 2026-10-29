import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const USAGE_DIR = join("logs", "usage");

/** Who made a decision: plain code, a small model with our key, or the user's agent. */
export type DecidedBy = "rules" | "spark" | "jev" | "agent";

export interface UsageEvent {
  at: string;
  /** tool: a result returned to the agent · decision: a small decision the Decider made or handed back. */
  kind: "tool" | "decision";
  /** Tool name, or decision kind (selector, triage). */
  name: string;
  ms: number;
  /** tool: size of the result. */
  chars?: number;
  /** tool: estimated tokens of the result (what it adds to the agent's context). */
  tokens?: number;
  /** decision: who answered. */
  by?: DecidedBy;
  /** decision: Level 1 model usage and cost. */
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
}

export interface UsageTotals {
  job: string;
  toolCalls: number;
  tokens: number;
  /** The largest single result. */
  maxTokens: number;
  decisions: Record<DecidedBy, number>;
  usd: number;
  levelOneTokens: number;
  /** When its latest event happened (from listUsage). */
  last?: string;
}

/** About 4 characters per token for the English, code and tables our tools return. An estimate, not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Counts what Wind Tunnel adds to the agent's context and what its Level 1 decisions cost,
 * per job: `.windtunnel/logs/usage/<job>.jsonl`.
 */
export class UsageMeter {
  readonly job: string;
  readonly file: string;
  private readonly events: UsageEvent[] = [];
  private loaded?: Promise<void>;

  constructor(stateDir: string, job: string) {
    if (!/^[\w.-]+$/.test(job)) throw new Error(`bad job id: ${job}`);
    this.job = job;
    this.file = join(stateDir, USAGE_DIR, `${job}.jsonl`);
  }

  /** A job for one MCP server session (WINDTUNNEL_JOB when set, e.g. by a hunt the viewer started). */
  static forSession(stateDir: string): UsageMeter {
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
    return new UsageMeter(stateDir, process.env.WINDTUNNEL_JOB ?? `mcp-${stamp.slice(0, 6)}-${stamp.slice(6)}`);
  }

  /** CLI use: WINDTUNNEL_JOB, else one job per day. */
  static forCli(stateDir: string): UsageMeter {
    return new UsageMeter(stateDir, process.env.WINDTUNNEL_JOB ?? `cli-${new Date().toISOString().slice(0, 10)}`);
  }

  /** Reads the job's earlier events (a CLI job spans several commands). */
  load(): Promise<void> {
    this.loaded ??= readFile(this.file, "utf8").then(
      (text) => {
        const earlier = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
        this.events.unshift(...earlier);
      },
      () => undefined,
    );
    return this.loaded;
  }

  async record(event: Omit<UsageEvent, "at">): Promise<void> {
    await this.load();
    const full: UsageEvent = { at: new Date().toISOString(), ...event };
    this.events.push(full);
    await mkdir(join(this.file, ".."), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(full)}\n`);
  }

  async tool(name: string, text: string, ms: number): Promise<void> {
    await this.record({ kind: "tool", name, ms, chars: text.length, tokens: estimateTokens(text) });
  }

  totals(): UsageTotals {
    return totalsOf(this.job, this.events);
  }

  list(): readonly UsageEvent[] {
    return this.events;
  }
}

export function totalsOf(job: string, events: readonly UsageEvent[]): UsageTotals {
  const totals: UsageTotals = {
    job,
    toolCalls: 0,
    tokens: 0,
    maxTokens: 0,
    decisions: { rules: 0, spark: 0, jev: 0, agent: 0 },
    usd: 0,
    levelOneTokens: 0,
  };
  for (const e of events) {
    if (e.kind === "tool") {
      totals.toolCalls++;
      totals.tokens += e.tokens ?? 0;
      totals.maxTokens = Math.max(totals.maxTokens, e.tokens ?? 0);
    } else {
      if (e.by) totals.decisions[e.by]++;
      // A Level 1 answer that was not sure enough still cost something.
      totals.usd += e.usd ?? 0;
      totals.levelOneTokens += (e.inputTokens ?? 0) + (e.outputTokens ?? 0);
    }
  }
  return totals;
}

/** `usage so far (job …): 14 tool outputs ≈ 9.2k tokens (budget 150k) · decisions: 3 by rules, 1 by Muse Spark ($0.0004), 1 for you` */
export function formatUsage(totals: UsageTotals, budget?: { tokens: number; usd: number }): string {
  const d = totals.decisions;
  const decided = [
    d.rules ? `${d.rules} by rules` : "",
    d.spark ? `${d.spark} by Muse Spark` : "",
    d.jev ? `${d.jev} by Jev` : "",
    d.agent ? `${d.agent} for you` : "",
  ].filter(Boolean);
  const spend = totals.usd > 0 || d.spark || d.jev ? ` ($${totals.usd.toFixed(4)}${budget ? ` of $${budget.usd}` : ""})` : "";
  return [
    `usage so far (job ${totals.job}): ${totals.toolCalls} tool output(s) ≈ ${kilo(totals.tokens)} tokens${budget ? ` (budget ${kilo(budget.tokens)})` : ""}`,
    decided.length ? `decisions: ${decided.join(", ")}${spend}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Every job's totals, newest first. */
export async function listUsage(stateDir: string, limit = 20): Promise<UsageTotals[]> {
  const dir = join(stateDir, USAGE_DIR);
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl"));
  const out: { totals: UsageTotals; last: string }[] = [];
  for (const f of files) {
    const events = (await readFile(join(dir, f), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
    out.push({ totals: totalsOf(f.replace(/\.jsonl$/, ""), events), last: events.at(-1)?.at ?? "" });
  }
  return out.sort((a, b) => b.last.localeCompare(a.last)).slice(0, limit).map((x) => ({ ...x.totals, ...(x.last ? { last: x.last } : {}) }));
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

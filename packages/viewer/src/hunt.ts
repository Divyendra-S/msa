import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

export const HUNTS_DIR = join("logs", "hunts");

/** One line of the agent's JSONL stream, read without knowing its exact schema. */
export interface HuntEvent {
  seq: number;
  /** ms since the hunt started. */
  at: number;
  /** message: the agent said something · tool: it called a tool · usage: token counts · output/stderr: plain lines · end: it exited. */
  kind: "message" | "tool" | "usage" | "event" | "output" | "stderr" | "end";
  /** The event's own type, e.g. `item.completed`. */
  type?: string;
  text?: string;
  tool?: string;
  usage?: HuntUsage;
  /** The line as received (cut). */
  raw?: string;
}

export interface HuntUsage {
  input: number;
  output: number;
  cached: number;
  usd: number;
}

export interface HuntInfo {
  id: string;
  prompt: string;
  /** The command, without the prompt. */
  command: string[];
  startedAt: string;
  endedAt?: string;
  status: "running" | "done" | "failed" | "stopped";
  exitCode?: number | null;
  /** Token counts the agent reported in its events. */
  usage: HuntUsage;
  events: number;
}

export interface HuntAvailability {
  ok: boolean;
  /** Why the button is off, in words for the user. */
  reason?: string;
  command: string[];
}

const MAX_RAW = 4_000;
const MAX_EVENTS = 5_000;
/** Credentials of other agents' providers never reach the hunt's process. */
const FOREIGN_ENV = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE|OPENAI_|CODEX_)/;

/**
 * Starts a headless Muse Code run (`muse exec --json`) from the viewer and turns its JSONL
 * stream into events. Billed to the Meta key in the viewer's shell; one hunt at a time.
 */
export class HuntManager {
  private readonly dir: string;
  private current?: { info: HuntInfo; child: ChildProcess; events: HuntEvent[]; started: number };
  private readonly listeners = new Set<(id: string, event?: HuntEvent, info?: HuntInfo) => void>();

  private readonly root: string;
  private readonly command: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(stateDir: string, root: string, command: string[], env: NodeJS.ProcessEnv = process.env) {
    this.dir = join(stateDir, HUNTS_DIR);
    this.root = root;
    this.command = command;
    this.env = env;
  }

  /** Called with each event, and with the hunt's info when its status changes. */
  subscribe(listener: (id: string, event?: HuntEvent, info?: HuntInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async availability(): Promise<HuntAvailability> {
    const command = this.command;
    const program = basename(command[0]!).replace(/\.(cmd|exe)$/i, "");
    if (program === "claude" || program === "codex") {
      return {
        ok: false,
        command,
        reason: `hunt.command runs ${program}: the Run button only starts Muse Code with the Meta key. Use "Open in Claude Code" to work with your own Claude login.`,
      };
    }
    if (!(await findExecutable(command[0]!, this.env.PATH ?? ""))) {
      return { ok: false, command, reason: `${command[0]} is not on the PATH of the shell that started the viewer. Install Muse Code, or set hunt.command in windtunnel.config.yaml.` };
    }
    if (!this.env.MODEL_API_KEY) {
      return { ok: false, command, reason: "MODEL_API_KEY is not set: start windtunnel view in the shell where you sourced scripts/muse-env.sh, so the hunt is billed to the Meta key." };
    }
    return { ok: true, command };
  }

  running(): HuntInfo | undefined {
    return this.current?.info;
  }

  async start(prompt: string): Promise<HuntInfo> {
    if (this.current) throw new HuntError(409, `hunt ${this.current.info.id} is still running`);
    const text = prompt.trim();
    if (!text) throw new HuntError(400, "empty prompt");
    if (text.length > 20_000) throw new HuntError(400, "prompt longer than 20,000 characters");
    const available = await this.availability();
    if (!available.ok) throw new HuntError(412, available.reason!);

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
    const id = `${stamp.slice(0, 6)}-${stamp.slice(6)}-${randomBytes(2).toString("hex")}`;
    await mkdir(this.dir, { recursive: true });
    const env = Object.fromEntries(Object.entries(this.env).filter(([k]) => !FOREIGN_ENV.test(k)));
    // The MCP server the agent starts counts its usage under this job, if the host passes the variable on.
    env.WINDTUNNEL_JOB = `hunt-${id}`;
    const child = spawn(this.command[0]!, [...this.command.slice(1), text], { cwd: this.root, env, stdio: ["ignore", "pipe", "pipe"] });
    const info: HuntInfo = {
      id,
      prompt: text,
      command: this.command,
      startedAt: new Date().toISOString(),
      status: "running",
      usage: { input: 0, output: 0, cached: 0, usd: 0 },
      events: 0,
    };
    const current = { info, child, events: [] as HuntEvent[], started: Date.now() };
    this.current = current;
    await this.save(info);
    this.emit(id, undefined, info);

    let writing = Promise.resolve();
    const push = (event: Omit<HuntEvent, "seq" | "at">) => {
      if (current.events.length >= MAX_EVENTS) return;
      const e: HuntEvent = { seq: current.events.length, at: Date.now() - current.started, ...event };
      current.events.push(e);
      info.events = current.events.length;
      if (e.usage) addUsage(info.usage, e.usage, e.type);
      writing = writing.then(() => appendFile(join(this.dir, `${id}.jsonl`), `${JSON.stringify(e)}\n`)).catch(() => undefined);
      this.emit(id, e);
    };
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.trim()) return;
      const raw = line.length > MAX_RAW ? `${line.slice(0, MAX_RAW)}…` : line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return push({ kind: "output", text: raw });
      }
      push({ ...readEvent(parsed), raw });
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.trim()) push({ kind: "stderr", text: line.slice(0, MAX_RAW) });
    });
    const finish = async (code: number | null, error?: string) => {
      if (this.current !== current) return;
      if (error) push({ kind: "stderr", text: error });
      info.exitCode = code;
      info.endedAt = new Date().toISOString();
      if (info.status === "running") info.status = code === 0 ? "done" : "failed";
      push({ kind: "end", text: `exited with ${code ?? "a signal"}${info.status === "stopped" ? " (stopped)" : ""}` });
      this.current = undefined;
      await writing;
      await this.save(info);
      this.emit(id, undefined, info);
    };
    child.on("error", (err) => void finish(null, `could not start ${this.command[0]}: ${err.message}`));
    child.on("close", (code) => void finish(code));
    return info;
  }

  /** Asks the hunt to stop (SIGINT), then insists. */
  stop(id: string): boolean {
    const current = this.current;
    if (!current || current.info.id !== id) return false;
    current.info.status = "stopped";
    current.child.kill("SIGINT");
    const term = setTimeout(() => current.child.kill("SIGTERM"), 5_000);
    const kill = setTimeout(() => current.child.kill("SIGKILL"), 10_000);
    current.child.once("close", () => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    return true;
  }

  /** Newest first. */
  async list(limit = 20): Promise<HuntInfo[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit);
    const out: HuntInfo[] = [];
    for (const f of files) {
      const info = f === `${this.current?.info.id}.json` ? this.current!.info : await readJson<HuntInfo>(join(this.dir, f));
      if (info) out.push(info.status === "running" && info !== this.current?.info ? { ...info, status: "stopped" } : info);
    }
    return out;
  }

  async get(id: string): Promise<{ info: HuntInfo; events: HuntEvent[] } | undefined> {
    if (!/^[\w-]+$/.test(id)) return undefined;
    if (this.current?.info.id === id) return { info: this.current.info, events: this.current.events };
    const info = await readJson<HuntInfo>(join(this.dir, `${id}.json`));
    if (!info) return undefined;
    const text = await readFile(join(this.dir, `${id}.jsonl`), "utf8").catch(() => "");
    // A hunt still "running" on disk belonged to a viewer that is gone.
    return { info: info.status === "running" ? { ...info, status: "stopped" } : info, events: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as HuntEvent) };
  }

  /** Stops a running hunt; for shutting the viewer down. */
  async close(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.stop(current.info.id);
    await new Promise<void>((resolve) => {
      if (current.child.exitCode !== null || current.child.signalCode !== null) return resolve();
      current.child.once("close", () => resolve());
    });
  }

  private emit(id: string, event?: HuntEvent, info?: HuntInfo): void {
    for (const l of this.listeners) l(id, event, info);
  }

  private save(info: HuntInfo): Promise<void> {
    return writeFile(join(this.dir, `${info.id}.json`), `${JSON.stringify(info, null, 2)}\n`);
  }
}

export class HuntError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * What a JSONL event says, whatever the agent's schema: Muse Code's stream is not documented, so
 * this reads the shapes agents commonly use (Codex-style `item.*` events, Claude-style
 * `assistant` messages with content blocks, flat `{type, text}` events) and keeps the raw line.
 */
export function readEvent(value: unknown): Omit<HuntEvent, "seq" | "at" | "raw"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "event", text: String(value) };
  const e = value as Record<string, any>;
  const type = str(e.type) ?? str(e.event) ?? str(e.kind) ?? str(e.msg?.type);
  const item = (e.item ?? e.data ?? e.msg ?? e.payload) as Record<string, any> | undefined;
  const usage = findUsage(e);
  const base = { ...(type ? { type } : {}), ...(usage ? { usage } : {}) };

  const tool = toolOf(e) ?? (item && typeof item === "object" ? toolOf(item) : undefined) ?? blocks(e.message?.content).tool;
  if (tool) return { kind: "tool", ...base, tool, ...(argsOf(e, item) ? { text: argsOf(e, item) } : {}) };
  const text =
    str(e.text) ??
    str(item?.text) ??
    str(e.message) ??
    blocks(e.message?.content).text ??
    blocks(e.content).text ??
    str(e.content) ??
    str(e.delta) ??
    str(e.result) ??
    str(item?.message) ??
    str(e.error?.message) ??
    str(e.error);
  if (text) return { kind: "message", ...base, text };
  return { kind: usage ? "usage" : "event", ...base };
}

function toolOf(o: Record<string, any>): string | undefined {
  const t = str(o.type) ?? "";
  if (t === "command_execution" || t === "local_shell_call") return `shell${str(o.command) ? `: ${str(o.command)}` : ""}`;
  const name = str(o.tool_name) ?? str(o.tool) ?? (/tool|function/i.test(t) ? str(o.name) : undefined);
  if (!name) return undefined;
  const server = str(o.server) ?? str(o.server_name);
  return server ? `${server}.${name}` : name;
}

function argsOf(e: Record<string, any>, item: Record<string, any> | undefined): string | undefined {
  const args = e.arguments ?? e.input ?? e.args ?? item?.arguments ?? item?.input ?? item?.args;
  if (args === undefined) return undefined;
  const text = typeof args === "string" ? args : JSON.stringify(args);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function blocks(content: unknown): { text?: string; tool?: string } {
  if (!Array.isArray(content)) return {};
  const texts = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  const tool = content.find((b) => b && (b.type === "tool_use" || b.type === "tool_call") && typeof b.name === "string");
  return { ...(texts.length ? { text: texts.join("\n") } : {}), ...(tool ? { tool: tool.name as string } : {}) };
}

/** Token counts anywhere in the first levels of an event, under the names providers use. */
function findUsage(o: Record<string, any>, depth = 0): HuntUsage | undefined {
  const u = o.usage ?? o.token_usage ?? o.tokens;
  if (u && typeof u === "object") {
    const n = (...keys: string[]) => keys.map((k) => u[k]).find((v) => typeof v === "number") ?? 0;
    const usage = {
      input: n("input_tokens", "prompt_tokens", "input"),
      output: n("output_tokens", "completion_tokens", "output"),
      cached: n("cached_input_tokens", "cache_read_input_tokens", "cached_tokens", "cached"),
      usd: n("cost", "cost_usd", "usd") || (typeof o.total_cost_usd === "number" ? o.total_cost_usd : 0),
    };
    if (usage.input || usage.output || usage.usd) return usage;
  }
  if (depth >= 2) return undefined;
  for (const v of Object.values(o)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const found = findUsage(v, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Turn-by-turn counts add up; a final summary event replaces the sum when it is larger. */
export function addUsage(total: HuntUsage, u: HuntUsage, type?: string): void {
  if (type && /result|summary|session\.(end|completed)|thread\.completed|^done$|^end$/i.test(type)) {
    if (u.input + u.output >= total.input + total.output) Object.assign(total, u);
    return;
  }
  total.input += u.input;
  total.output += u.output;
  total.cached += u.cached;
  total.usd += u.usd;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

async function findExecutable(command: string, path: string): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes("/") ? [command] : path.split(delimiter).filter(Boolean).map((d) => join(d, command));
  for (const c of candidates) {
    if (await access(c, constants.X_OK).then(() => true, () => false)) return c;
  }
  return undefined;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text ? (JSON.parse(text) as T) : undefined;
}

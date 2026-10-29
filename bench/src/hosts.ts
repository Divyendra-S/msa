import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { addUsage, readEvent } from "@windtunnel/viewer";
import { REPO_ROOT } from "./cases.ts";
import { PLAYWRIGHT_MCP, SETUPS, saveTrial, type TrialInfo, trialName, type TrialRun } from "./trial.ts";

const exec = promisify(execFile);

/**
 * Muse Code, headless: one prompt to completion, JSONL events on stdout, billed to the Meta key.
 * `{model}`, `{max_steps}` and `{prompt_file}` are filled in per trial.
 */
export const MUSE_COMMAND = ["muse", "exec", "--json", "--disable-approval", "--max-model-steps", "{max_steps}", "--model", "{model}", "--prompt-file", "{prompt_file}"];
export const DEFAULT_MODEL = "muse-wonder-1.0";

/** Never another agent's login: these never reach the host. */
const OTHER_AGENTS = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_)/;

export interface HostOptions {
  /** The command with placeholders (default: Muse Code). */
  command?: string[];
  model?: string;
  maxSteps?: number;
  /** Give the agent its own HOME, so it sees only this setup's MCP servers and skills (default true). */
  isolateHome?: boolean;
  /** Added to the agent's environment (e.g. PORT, so parallel trials start the shop on different ports). */
  env?: Record<string, string>;
  /** Echo the agent's messages and tool calls. */
  onEvent?: (line: string) => void;
}

/** Hosts that run on someone's own subscription must not be run headless by us. */
export function refusedHost(command: string[]): string | undefined {
  const name = basename(command[0] ?? "");
  if (name === "claude" || name === "codex") {
    return `${name} runs on its user's own login: run it yourself (--host manual) instead; the benchmark only starts hosts billed to an API key`;
  }
  return undefined;
}

/** The environment the agent runs in: this setup's tools on PATH, its own HOME, no other agent's keys. */
export async function hostEnv(trial: TrialInfo, isolateHome = true): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !OTHER_AGENTS.test(k)) env[k] = v;
  const setup = SETUPS[trial.setup];
  env.PATH = `${join(trial.dir, "bin")}:${env.PATH ?? ""}`;
  env.WINDTUNNEL_JOB = `bench-${trial.id}`;
  if (setup.decider) env.WINDTUNNEL_DECIDER = setup.decider;
  if (setup.decider === "spark" && !env.MODEL_API_KEY) throw new Error("setup C needs MODEL_API_KEY (Muse Spark at Level 1)");
  // Muse Code reads META_API_KEY in non-interactive runs; the Meta Model API key is the same key.
  if (env.MODEL_API_KEY && !env.META_API_KEY) env.META_API_KEY = env.MODEL_API_KEY;
  if (isolateHome) {
    const real = homedir();
    env.HOME = join(trial.dir, "home");
    env.XDG_CONFIG_HOME = join(env.HOME, ".config");
    // Caches stay where they are, so nothing is downloaded again.
    env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === "darwin" ? join(real, "Library", "Caches", "ms-playwright") : join(real, ".cache", "ms-playwright");
    env.npm_config_cache ??= join(real, ".npm");
    const store = await exec("pnpm", ["store", "path"]).then((r) => r.stdout.trim(), () => "");
    if (store) env.npm_config_store_dir ??= store;
    if (env.NVM_DIR === undefined && existsSync(join(real, ".nvm"))) env.NVM_DIR = join(real, ".nvm");
  }
  return env;
}

/** Runs the agent on the trial's task until it exits or the time cap; logs its events and adds up its usage. */
export async function runHost(trial: TrialInfo, options: HostOptions = {}): Promise<TrialRun> {
  const template = options.command ?? MUSE_COMMAND;
  const refused = refusedHost(template);
  if (refused) throw new Error(refused);
  const fill = (s: string) =>
    s
      .replaceAll("{model}", options.model ?? trial.model ?? DEFAULT_MODEL)
      .replaceAll("{max_steps}", String(options.maxSteps ?? 200))
      .replaceAll("{prompt_file}", join(trial.dir, "task.md"));
  const command = template.map(fill);
  const env = { ...(await hostEnv(trial, options.isolateHome ?? true)), ...options.env };

  const started = Date.now();
  const events = createWriteStream(join(trial.dir, "events.jsonl"));
  const log = createWriteStream(join(trial.dir, "host.log"));
  const child = spawn(command[0]!, command.slice(1), { cwd: trial.app, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  const usage = { input: 0, output: 0, cached: 0, usd: 0 };
  let lines = 0;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    events.write(`${line}\n`);
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const e = readEvent(parsed);
    if (e.usage) addUsage(usage, e.usage, e.type);
    if (options.onEvent && (e.kind === "message" || e.kind === "tool")) options.onEvent(`${e.kind === "tool" ? `→ ${e.tool}` : e.text}`.slice(0, 200));
  });
  child.stderr!.pipe(log);

  let timedOut = false;
  // The whole process group, so the agent's own children stop too.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, s);
    } catch {
      /* already gone */
    }
  };
  const timers = [
    setTimeout(() => ((timedOut = true), signal("SIGINT")), trial.timeCapMs),
    setTimeout(() => signal("SIGTERM"), trial.timeCapMs + 15_000),
    setTimeout(() => signal("SIGKILL"), trial.timeCapMs + 30_000),
  ];
  const stop = () => signal("SIGINT");
  process.once("SIGINT", stop);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", (err) => {
      log.write(`could not start ${command[0]}: ${err.message}\n`);
      resolve(null);
    });
    child.once("exit", (code) => resolve(code));
  });
  process.off("SIGINT", stop);
  for (const t of timers) clearTimeout(t);
  await Promise.all([new Promise((r) => events.end(r)), new Promise((r) => log.end(r))]);

  const run: TrialRun = { command, startedAt: new Date(started).toISOString(), wallMs: Date.now() - started, exitCode, timedOut, usage, events: lines };
  trial.run = run;
  await saveTrial(trial);
  return run;
}

/** What to do by hand for a trial in Claude Code (development runs on your own login; they don't count for the published numbers). */
export function manualInstructions(trial: TrialInfo): string {
  const setup = SETUPS[trial.setup];
  const env = setup.windtunnel ? `PATH="${join(trial.dir, "bin")}:$PATH" WINDTUNNEL_JOB=bench-${trial.id} WINDTUNNEL_DECIDER=${setup.decider} ` : `PATH="${join(trial.dir, "bin")}:$PATH" `;
  // B and C: the plugin's skills, and its MCP server, which finds `windtunnel` on PATH (the trial's bin/).
  const claude = setup.windtunnel
    ? `claude --plugin-dir "${join(REPO_ROOT, "plugins", "windtunnel")}"`
    : `claude --strict-mcp-config --mcp-config "${join(trial.dir, "mcp.json")}"`;
  return [
    `Trial ${trial.id} (${trialName(trial)}): case ${trial.case}, setup ${trial.setup} (${setup.title})`,
    "",
    "1. In a new terminal:",
    `   cd "${trial.app}"`,
    `   ${env}${claude}`,
    `2. Paste the task (${join(trial.dir, "task.md")}) and let it work. Time cap: ${Math.round(trial.timeCapMs / 60_000)} min.`,
    "3. When it is done, note the tokens (/cost or /usage) and the minutes, then score it:",
    `   pnpm bench score "${trial.dir}" --tokens <n> --minutes <m>`,
    ...(setup.decider === "spark" ? ["", "Setup C needs MODEL_API_KEY in the MCP server's environment; run C on Muse Code (--host muse) instead."] : []),
    ...(setup.playwright ? ["", `Playwright MCP (${PLAYWRIGHT_MCP}) is in mcp.json; the first start downloads it.`] : []),
  ].join("\n");
}

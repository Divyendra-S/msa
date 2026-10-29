import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadCases, PATCH_STRIP, REPO_ROOT, type ZooCase } from "./cases.ts";

const exec = promisify(execFile);

export type Setup = "A" | "B" | "C";

export const SETUPS: Record<Setup, { title: string; windtunnel: boolean; decider?: "rules" | "spark"; playwright: boolean }> = {
  A: { title: "no Wind Tunnel (Playwright MCP)", windtunnel: false, playwright: true },
  B: { title: "Wind Tunnel, rules only", windtunnel: true, decider: "rules", playwright: false },
  C: { title: "Wind Tunnel + Muse Spark at Level 1", windtunnel: true, decider: "spark", playwright: false },
};

export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83";
export const TASK_FILE = join(REPO_ROOT, "bench", "task.md");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const MOCK_PAY = join(REPO_ROOT, "zoo", "mock-pay", "src", "bin.ts");
/** Who the trial's single commit is by: nothing that points at this repository. */
export const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Shop",
  GIT_AUTHOR_EMAIL: "shop@example.invalid",
  GIT_COMMITTER_NAME: "Shop",
  GIT_COMMITTER_EMAIL: "shop@example.invalid",
};

export interface TrialInfo {
  /** Opaque (`t3f9a…`): the folder name, so nothing the agent can see names the case. */
  id: string;
  batch: string;
  /** In trial.json only as a hash (`caseKey`). */
  case: string;
  setup: Setup;
  /** `muse`, `command` or `manual`. */
  host: string;
  model?: string;
  dir: string;
  /** The agent's working folder: the shop with the case applied, one commit, no history. */
  app: string;
  baseCommit: string;
  createdAt: string;
  timeCapMs: number;
  run?: TrialRun;
}

export interface TrialRun {
  command: string[];
  startedAt: string;
  wallMs: number;
  exitCode: number | null;
  timedOut: boolean;
  usage: { input: number; output: number; cached: number; usd: number };
  /** Lines of JSONL the host printed. */
  events: number;
}

/** Shop files the agent gets: tracked and new ones, minus Wind Tunnel's for setup A and its experiments, rules and flows for B and C (login.ts stays). */
async function shopFiles(setup: Setup): Promise<string[]> {
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "zoo/shop"], {
    cwd: REPO_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((f) => f.slice("zoo/shop/".length))
    .filter((f) => {
      if (f === "windtunnel.config.yaml" || f.startsWith(".windtunnel/")) {
        if (!SETUPS[setup].windtunnel) return false;
        return f === "windtunnel.config.yaml" || f === ".windtunnel/.gitignore" || f === ".windtunnel/flows/login.ts";
      }
      return true;
    })
    .filter((f) => existsSync(join(REPO_ROOT, "zoo", "shop", f)));
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function shim(path: string, script: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(path, 0o755);
}

/**
 * Makes a trial folder outside this repository:
 *
 *   <trial>/app/        the shop with the case applied, as one commit (no history to read the answer from)
 *   <trial>/bin/        mock-pay, and windtunnel for B and C
 *   <trial>/home/       HOME for the agent (Muse Code): MCP servers and skills for the setup
 *   <trial>/mcp.json    the same MCP servers for Claude Code (--mcp-config), for manual trials
 *   <trial>/task.md     the task, the same for every setup
 *   <trial>/trial.json
 */
export async function prepareTrial(
  zooCase: ZooCase,
  setup: Setup,
  options: { trialsDir: string; batch: string; host: string; model?: string; timeCapMs: number; install?: boolean },
): Promise<TrialInfo> {
  if (options.trialsDir.startsWith(REPO_ROOT)) throw new Error(`put trials outside this repository (${REPO_ROOT}): the agent must not find the answers`);
  const id = `t${randomBytes(4).toString("hex")}`;
  const dir = join(options.trialsDir, options.batch, id);
  const app = join(dir, "app");
  await mkdir(app, { recursive: true });

  for (const file of await shopFiles(setup)) {
    await mkdir(dirname(join(app, file)), { recursive: true });
    await copyFile(join(REPO_ROOT, "zoo", "shop", file), join(app, file));
  }
  await git(app, ["init", "-q", "-b", "main"]);
  // The patch file goes nowhere near the trial.
  const scratch = await mkdtemp(join(tmpdir(), "bench-patch-"));
  try {
    await writeFile(join(scratch, "p"), zooCase.patch);
    await git(app, ["apply", `-p${PATCH_STRIP}`, join(scratch, "p")]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await git(app, ["add", "-A"]);
  await git(app, ["commit", "-q", "-m", "Shop"]);
  const baseCommit = await git(app, ["rev-parse", "HEAD"]);

  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await shim(join(bin, "mock-pay"), MOCK_PAY);
  if (SETUPS[setup].windtunnel) await shim(join(bin, "windtunnel"), CLI);

  // MCP servers: Muse Code reads them from ~/.config/muse/settings.json; Claude Code from --mcp-config.
  const servers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  if (SETUPS[setup].playwright) servers.playwright = { command: "npx", args: ["-y", PLAYWRIGHT_MCP] };
  if (SETUPS[setup].windtunnel) servers.windtunnel = { command: join(bin, "windtunnel"), args: ["mcp"], env: { WINDTUNNEL_DECIDER: SETUPS[setup].decider! } };
  const home = join(dir, "home");
  await mkdir(join(home, ".config", "muse"), { recursive: true });
  const museServers = Object.fromEntries(
    Object.entries(servers).map(([name, s]) => [name, { transport: "stdio", command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }]),
  );
  await writeFile(join(home, ".config", "muse", "settings.json"), `${JSON.stringify({ schema_version: 1, mcp_servers: museServers }, null, 2)}\n`);
  await writeFile(join(dir, "mcp.json"), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  if (SETUPS[setup].windtunnel) {
    // User-level skills (~/.agents/skills), so the app's own commit stays the shop alone.
    await exec(process.execPath, [CLI, "skills", "--out", join(home, ".agents", "skills"), "--prefix", "windtunnel-"], { cwd: app });
  }
  await copyFile(TASK_FILE, join(dir, "task.md"));

  if (options.install !== false) {
    await exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-workspace", "--reporter=silent"], { cwd: app, maxBuffer: 16 * 1024 * 1024 });
  }

  const info: TrialInfo = {
    id,
    batch: options.batch,
    case: zooCase.id,
    setup,
    host: options.host,
    ...(options.model ? { model: options.model } : {}),
    dir,
    app,
    baseCommit,
    createdAt: new Date().toISOString(),
    timeCapMs: options.timeCapMs,
  };
  await saveTrial(info);
  return info;
}

/** How trial.json names the case: a hash the agent can't read the case from. */
function caseKey(trialId: string, caseId: string): string {
  return createHash("sha256").update(`${trialId}:${caseId}`).digest("hex").slice(0, 16);
}

export async function saveTrial(info: TrialInfo): Promise<void> {
  const { case: caseId, ...rest } = info;
  await writeFile(join(info.dir, "trial.json"), `${JSON.stringify({ ...rest, caseKey: caseKey(info.id, caseId) }, null, 2)}\n`);
}

export async function loadTrial(dir: string): Promise<TrialInfo> {
  const data = JSON.parse(await readFile(join(dir, "trial.json"), "utf8")) as Omit<TrialInfo, "case"> & { caseKey: string };
  const found = (await loadCases()).find((c) => caseKey(data.id, c.id) === data.caseKey);
  if (!found) throw new Error(`${dir}: its case is not in zoo/cases`);
  const { caseKey: _key, ...rest } = data;
  return { ...rest, case: found.id };
}

/** `<case>-<setup>`: how results and the scoreboard name a trial. */
export function trialName(info: TrialInfo): string {
  return `${info.case}-${info.setup}`;
}

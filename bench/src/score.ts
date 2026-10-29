import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { clean, type Experiment, listUsage, loadExperiments, Runner } from "@windtunnel/core";
import { PATCH_STRIP, REPO_ROOT, type ZooCase } from "./cases.ts";
import { GIT_IDENTITY, type Setup, type TrialInfo, trialName } from "./trial.ts";

const exec = promisify(execFile);
const CLI = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");

/** Reported prices per 1M tokens (plan §5.1; check Meta's pricing page). Cached input is priced as input. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "muse-wonder-1.0": { input: 4, output: 20 },
  "muse-spark-1.3": { input: 1.25, output: 4.25 },
};

export interface Finding {
  title: string;
  summary?: string;
  files: string[];
  reproduce?: string;
  fixed?: boolean;
}

/** match: fails with the bug, passes on the clean shop · not reproduced: never fails with the bug · also on clean: fails on both · no command · control: any finding on a control. */
export type Verdict = "match" | "not reproduced" | "also on clean" | "no command" | "control";

export interface FindingScore extends Finding {
  verdict: Verdict;
  /** Runs of `reproduce` that failed (exit ≠ 0) on the bug version and on the clean shop. */
  onBug?: { failed: number; runs: number; timedOut: number };
  onClean?: { failed: number; runs: number; timedOut: number };
  namesHandler: boolean;
}

export interface TrialScore {
  /** `<case>-<setup>`, `-2`… for repeats in one batch. */
  trial: string;
  /** The trial's folder name. */
  trialId: string;
  batch: string;
  case: string;
  title: string;
  setup: Setup;
  control: boolean;
  host: string;
  model?: string;
  /** yes: a finding reproduces the bug (fails with it, passes without) · claimed: names the bug's file but doesn't reproduce it · no. */
  found: "yes" | "claimed" | "no" | "n/a";
  /** The best matching finding's failures on the bug version, e.g. `3/3`. */
  reproduced?: string;
  /** A matching (or claimed) finding names the file with the bug. */
  handler: boolean;
  /** The case's hidden experiment on the agent's final code: passes in every run = fixed. */
  fixed?: { ok: number; runs: number; outcome: string; run: string };
  /** Other hidden experiments that no longer pass on the final code. */
  regressions: string[];
  falseAlarms: number;
  findings: FindingScore[];
  changed: { fix: string[]; tests: string[] };
  usage: { input: number; output: number; cached: number; hostUsd: number; level1Usd: number; usd: number; toolOutputTokens: number; estimated: boolean };
  wallMs?: number;
  timedOut?: boolean;
  notes: string[];
  scoredAt: string;
}

export interface ScoreOptions {
  /** Runs of the case's experiment on the final code (default 5). */
  fixRuns?: number;
  /** Runs of every other hidden experiment, for regressions (default 1). */
  regressionRuns?: number;
  /** Runs of each reproduce command on the bug and on the clean shop (default 3). */
  reproRuns?: number;
  reproTimeoutMs?: number;
  /** For trials run by hand: the host's numbers. */
  tokens?: number;
  minutes?: number;
  usd?: number;
  log?: (line: string) => void;
}

/** Files that are tests or reproductions (copied onto the bug and clean versions), not part of the fix. */
const TESTY = /(^|\/)(\.windtunnel|tests?|e2e|__tests__)(\/|$)|\.(spec|test)\.[cm]?[jt]sx?$|^playwright\.config\.|^windtunnel\.config\.yaml$|^bench-report\.json$/;
/** The app's own code: an added file here is part of the fix. */
const SOURCE = /^(app|components|lib|db|pages|src|styles|public)\/|^(middleware\.[jt]s|next\.config\.[cm]?[jt]s|package\.json|pnpm-lock\.yaml|tsconfig\.json)$/;
/** Signs the agent read the answers instead of finding them. */
const PEEKED = /zoo\/cases|zoo\/shop\/\.windtunnel|bug\.patch|control\.patch|wrong-fix\.patch/;
/** Keys that would let scoring spend money: reproductions run with rules only. */
const NO_KEYS = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_|MODEL_API_KEY$|META_API_KEY$|JEV_|TYPESAFE_|OPENROUTER_|AI_GATEWAY_)/;

export function isTestFile(path: string, status: string): boolean {
  return TESTY.test(path) || (status === "A" && !SOURCE.test(path));
}

export function parseReport(text: string): Finding[] {
  const data = JSON.parse(text) as { findings?: unknown };
  if (!Array.isArray(data.findings)) throw new Error("no findings list");
  return data.findings.map((f: any, i) => {
    if (!f || typeof f !== "object") throw new Error(`finding ${i + 1} is not an object`);
    return {
      title: String(f.title ?? `finding ${i + 1}`),
      ...(typeof f.summary === "string" ? { summary: f.summary } : {}),
      files: Array.isArray(f.files) ? f.files.map(String) : typeof f.files === "string" ? [f.files] : [],
      ...(typeof f.reproduce === "string" && f.reproduce.trim() ? { reproduce: f.reproduce.trim() } : {}),
      ...(typeof f.fixed === "boolean" ? { fixed: f.fixed } : {}),
    };
  });
}

export function namesFile(finding: Finding, file: string | undefined): boolean {
  if (!file) return false;
  const norm = (p: string) => p.trim().replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
  return finding.files.some((f) => norm(f) === file || norm(f).endsWith(`/${file}`));
}

/** Verdicts, found, reproduced, handler and false alarms from the findings and their reproduction runs. */
export function judge(zooCase: ZooCase, findings: FindingScore[]): Pick<TrialScore, "found" | "reproduced" | "handler" | "falseAlarms"> {
  if (zooCase.control) return { found: "n/a", handler: false, falseAlarms: findings.length };
  const matches = findings.filter((f) => f.verdict === "match");
  const claimed = findings.filter((f) => f.verdict === "no command" && f.namesHandler);
  const best = [...matches].sort((a, b) => b.onBug!.failed / b.onBug!.runs - a.onBug!.failed / a.onBug!.runs)[0];
  return {
    found: matches.length ? "yes" : claimed.length ? "claimed" : "no",
    ...(best ? { reproduced: `${best.onBug!.failed}/${best.onBug!.runs}` } : {}),
    handler: (matches.length ? matches : claimed).some((f) => f.namesHandler),
    // A claim that names something else and can't be shown, or a reproduction that never fails with the bug.
    falseAlarms: findings.filter((f) => f.verdict === "not reproduced" || (f.verdict === "no command" && !f.namesHandler)).length,
  };
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, env: { ...process.env, ...GIT_IDENTITY, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** The agent's final working tree (untracked files too, ignored ones not) as a commit on top of the base, at refs/bench/final. */
async function snapshot(trial: TrialInfo): Promise<string> {
  const index = join(trial.dir, ".score-index");
  await rm(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  await git(trial.app, ["read-tree", trial.baseCommit], env);
  await git(trial.app, ["add", "-A"], env);
  const tree = await git(trial.app, ["write-tree"], env);
  await rm(index, { force: true });
  const commit = await git(trial.app, ["commit-tree", tree, "-p", trial.baseCommit, "-m", "final (bench)"]);
  await git(trial.app, ["update-ref", "refs/bench/final", commit]);
  return commit;
}

async function changedFiles(trial: TrialInfo, final: string): Promise<{ path: string; status: string }[]> {
  const out = await git(trial.app, ["diff", "--name-status", "--no-renames", "-z", trial.baseCommit, final]);
  const parts = out.split("\0").filter(Boolean);
  const files: { path: string; status: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i]!, path: parts[i + 1]! });
  return files;
}

/** A worktree of the trial at `commit` in score/<name>, with the agent's tests and reproductions copied in. */
async function worktree(trial: TrialInfo, name: string, commit: string, tests: string[]): Promise<string> {
  const dir = join(trial.dir, "score", name);
  await git(trial.app, ["worktree", "add", "--detach", "-q", dir, commit]);
  if (tests.length) await git(dir, ["checkout", "refs/bench/final", "--", ...tests]);
  return dir;
}

function reproEnv(trial: TrialInfo): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !NO_KEYS.test(k)) env[k] = v;
  env.PATH = `${join(trial.dir, "bin")}:${env.PATH ?? ""}`;
  env.WINDTUNNEL_DECIDER = "rules";
  env.WINDTUNNEL_JOB = `bench-score-${trial.id}`;
  env.CI = "1";
  return env;
}

/** Runs a shell command in `cwd`; resolves its exit code (null on timeout). */
function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutMs: number, logFile: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => chunks.push(d));
    child.stderr!.on("data", (d: Buffer) => chunks.push(d));
    const kill = (s: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, s);
      } catch {
        /* gone */
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), kill("SIGTERM"), setTimeout(() => kill("SIGKILL"), 10_000).unref()), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      void writeFile(logFile, Buffer.concat(chunks).subarray(-200_000)).finally(() => resolve(timedOut ? null : (code ?? 1)));
    });
    child.once("error", () => resolve(1));
  });
}

async function install(dir: string): Promise<void> {
  await exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-workspace", "--reporter=silent"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }).catch(
    () => exec("pnpm", ["install", "--prefer-offline", "--ignore-workspace", "--reporter=silent"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 }),
  );
}

/** Drops what Wind Tunnel made for a scoring folder (databases, worktrees, processes). */
async function cleanWindTunnel(dir: string): Promise<void> {
  if (existsSync(join(dir, "windtunnel.config.yaml"))) await exec(process.execPath, [CLI, "clean", "--all", "--cwd", dir]).catch(() => undefined);
}

/** The zoo's own experiments, flows, rules and config, instead of the agent's. */
async function useZooExperiments(dir: string): Promise<void> {
  await rm(join(dir, ".windtunnel"), { recursive: true, force: true });
  const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "zoo/shop/.windtunnel", "zoo/shop/windtunnel.config.yaml"], { cwd: REPO_ROOT });
  for (const file of stdout.split("\0").filter(Boolean)) {
    const target = join(dir, file.slice("zoo/shop/".length));
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(REPO_ROOT, file), target);
  }
}

/** Runs the case's hidden experiment (fixRuns times) and every other one (regressionRuns times) on the final code. */
async function hiddenCheck(dir: string, zooCase: ZooCase, options: ScoreOptions): Promise<Pick<TrialScore, "fixed" | "regressions">> {
  await useZooExperiments(dir);
  const runner = await Runner.open(dir);
  try {
    const all = await loadExperiments(runner.project);
    const own = (e: Experiment) => e.id === zooCase.experiment;
    const results = await runner.run(
      all.map((e) => ({ ...e, repeat: own(e) ? (options.fixRuns ?? 5) : (options.regressionRuns ?? 1) })),
      { trace: "off" },
    );
    const mine = results.find((r) => r.experiment === zooCase.experiment);
    return {
      ...(mine ? { fixed: { ok: mine.reps.filter((r) => r.outcome === "ok").length, runs: mine.reps.length, outcome: mine.outcome, run: mine.runId } } : {}),
      regressions: results.filter((r) => r.experiment !== zooCase.experiment && r.outcome !== "pass").map((r) => `${r.experiment}: ${r.outcome} (run ${r.runId})`),
    };
  } finally {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner.close();
  }
}

export async function scoreTrial(trial: TrialInfo, zooCase: ZooCase, options: ScoreOptions = {}): Promise<TrialScore> {
  const log = options.log ?? (() => undefined);
  const notes: string[] = [];
  const final = await snapshot(trial);

  let findings: Finding[] = [];
  const reportText = await readFile(join(trial.app, "bench-report.json"), "utf8").catch(() => undefined);
  if (reportText === undefined) notes.push("no bench-report.json: scored as no findings");
  else {
    try {
      findings = parseReport(reportText);
    } catch (err) {
      notes.push(`bench-report.json unreadable (${(err as Error).message}): scored as no findings`);
    }
  }

  const files = await changedFiles(trial, final);
  const tests = files.filter((f) => f.status !== "D" && isTestFile(f.path, f.status)).map((f) => f.path);
  const fix = files.filter((f) => !isTestFile(f.path, f.status)).map((f) => f.path);

  for (const name of ["events.jsonl", "host.log"]) {
    const text = await readFile(join(trial.dir, name), "utf8").catch(() => "");
    const hit = PEEKED.exec(text);
    if (hit) notes.push(`the agent's ${name} mentions "${hit[0]}": it may have looked outside its folder`);
  }

  const scoreDir = join(trial.dir, "score");
  await rm(scoreDir, { recursive: true, force: true });
  await git(trial.app, ["worktree", "prune"]);
  await mkdir(scoreDir, { recursive: true });
  const scored: FindingScore[] = [];
  let hidden: Pick<TrialScore, "fixed" | "regressions"> = { regressions: [] };
  try {
    log(`hidden check: ${zooCase.experiment ?? "every experiment"} on the final code`);
    hidden = await hiddenCheck(await worktree(trial, "final", final, []), zooCase, options);

    const commands = [...new Set(findings.flatMap((f) => (f.reproduce && !zooCase.control ? [f.reproduce] : [])))];
    const runs = options.reproRuns ?? 3;
    const results = new Map<string, { onBug: FindingScore["onBug"]; onClean: FindingScore["onClean"] }>();
    if (commands.length) {
      const bugDir = await worktree(trial, "bug", trial.baseCommit, tests);
      const cleanDir = await worktree(trial, "clean", trial.baseCommit, tests);
      await writeFile(join(scoreDir, "case.patch"), zooCase.patch);
      await git(cleanDir, ["apply", "-R", `-p${PATCH_STRIP}`, join(scoreDir, "case.patch")]);
      await Promise.all([install(bugDir), install(cleanDir)]);
      const env = reproEnv(trial);
      for (const [i, command] of commands.entries()) {
        const tally = { onBug: { failed: 0, runs, timedOut: 0 }, onClean: { failed: 0, runs, timedOut: 0 } };
        for (const [side, dir] of [["onBug", bugDir], ["onClean", cleanDir]] as const) {
          for (let n = 1; n <= runs; n++) {
            log(`reproduce ${i + 1}/${commands.length} on the ${side === "onBug" ? "bug" : "clean shop"}, run ${n}/${runs}: ${command.slice(0, 80)}`);
            const code = await runCommand(command, dir, env, options.reproTimeoutMs ?? 600_000, join(scoreDir, `repro-${i + 1}-${side}-${n}.log`));
            if (code !== 0) tally[side].failed += 1;
            if (code === null) tally[side].timedOut += 1;
          }
        }
        results.set(command, tally);
      }
      await Promise.all([cleanWindTunnel(bugDir), cleanWindTunnel(cleanDir)]);
    }

    for (const f of findings) {
      const namesHandler = namesFile(f, zooCase.handler);
      if (zooCase.control) scored.push({ ...f, verdict: "control", namesHandler });
      else if (!f.reproduce) scored.push({ ...f, verdict: "no command", namesHandler });
      else {
        const r = results.get(f.reproduce)!;
        const verdict: Verdict = r.onBug!.failed === 0 ? "not reproduced" : r.onClean!.failed > 0 ? "also on clean" : "match";
        scored.push({ ...f, verdict, namesHandler, onBug: r.onBug, onClean: r.onClean });
      }
    }
  } finally {
    for (const name of ["final", "bug", "clean"]) {
      if (existsSync(join(scoreDir, name))) await git(trial.app, ["worktree", "remove", "--force", join(scoreDir, name)]).catch(() => undefined);
    }
    await git(trial.app, ["worktree", "prune"]).catch(() => undefined);
  }

  const wt = await listUsage(join(trial.app, ".windtunnel"), 1_000).catch(() => []);
  const level1Usd = wt.reduce((n, t) => n + t.usd, 0);
  const toolOutputTokens = wt.reduce((n, t) => n + t.tokens, 0);
  // Tokens entered by hand (a trial run in Claude Code) are a total: kept as input, not priced.
  const host = options.tokens !== undefined ? { input: options.tokens, output: 0, cached: 0, usd: 0 } : (trial.run?.usage ?? { input: 0, output: 0, cached: 0, usd: 0 });
  const { input, output } = host;
  const price = options.tokens === undefined ? PRICES[trial.model ?? ""] : undefined;
  const estimated = options.usd === undefined && !host.usd && !!price;
  const hostUsd = options.usd ?? (host.usd || (price ? (input * price.input + output * price.output) / 1e6 : 0));
  if (options.tokens !== undefined) notes.push("tokens entered by hand (the session's total)");
  if (trial.run?.timedOut) notes.push(`stopped at the time cap (${Math.round(trial.timeCapMs / 60_000)} min)`);

  const score: TrialScore = {
    trial: trialName(trial),
    trialId: trial.id,
    batch: trial.batch,
    case: zooCase.id,
    title: zooCase.title,
    setup: trial.setup,
    control: zooCase.control,
    host: trial.host,
    ...(trial.model ? { model: trial.model } : {}),
    ...judge(zooCase, scored),
    ...hidden,
    findings: scored,
    changed: { fix, tests },
    usage: { input, output, cached: host.cached, hostUsd, level1Usd, usd: hostUsd + level1Usd, toolOutputTokens, estimated },
    ...(options.minutes !== undefined ? { wallMs: options.minutes * 60_000 } : trial.run ? { wallMs: trial.run.wallMs } : {}),
    ...(trial.run?.timedOut ? { timedOut: true } : {}),
    notes,
    scoredAt: new Date().toISOString(),
  };
  await writeFile(join(trial.dir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
  return score;
}

/** Copies a scored trial into the repository's results: the score, the agent's report and its diff. */
export async function publishScore(trial: TrialInfo, score: TrialScore, resultsDir: string): Promise<string> {
  const dir = join(resultsDir, trial.batch);
  await mkdir(dir, { recursive: true });
  // Scored again: the same name. Another trial of the same case and setup: -2, -3…
  let name = score.trial;
  for (let n = 2; ; n++) {
    const existing = await readFile(join(dir, `${name}.json`), "utf8").then((t) => JSON.parse(t) as TrialScore, () => undefined);
    if (!existing || existing.trialId === trial.id) break;
    name = `${score.trial}-${n}`;
  }
  score.trial = name;
  await writeFile(join(trial.dir, "score.json"), `${JSON.stringify(score, null, 2)}\n`);
  await writeFile(join(dir, `${name}.json`), `${JSON.stringify(score, null, 2)}\n`);
  const report = await readFile(join(trial.app, "bench-report.json"), "utf8").catch(() => undefined);
  if (report !== undefined) await writeFile(join(dir, `${name}.report.json`), report);
  const diff = await git(trial.app, ["diff", trial.baseCommit, "refs/bench/final", "--", ".", ":(exclude)bench-report.json"]).catch(() => "");
  if (diff) await writeFile(join(dir, `${name}.diff`), `${diff}\n`);
  return dir;
}

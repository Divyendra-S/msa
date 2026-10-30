import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Branches,
  browserStatus,
  chromiumStatus,
  type CodeVersionSpec,
  clean,
  ConfigError,
  createAvd,
  DEFAULT_AVD,
  DEFAULT_IMAGE,
  findAndroidSdk,
  findAppium,
  listAvds,
  listSystemImages,
  runningEmulators,
  stopEmulator,
  systemImageDir,
  avdHome,
  describeDatabase,
  formatProof,
  formatResults,
  formatUsage,
  listUsage,
  loadExperiments,
  openProject,
  prove,
  Runner,
  runningViewer,
  runScript,
  type Seam,
  writeProofBranch,
  stopOnSignals,
  type TraceMode,
  UsageMeter,
} from "@windtunnel/core";
import {
  afterTriage,
  answerDecision,
  buildAppMap,
  crawl,
  Decider,
  DecisionStore,
  findAffected,
  formatAffected,
  formatAffectedRun,
  formatAppMap,
  formatCrawl,
  formatDecision,
  formatSweep,
  formatTriage,
  readCrawl,
  seedSchema,
  sortFailures,
} from "@windtunnel/explorer";
import { findProjectDir, serveStdio, Workspace } from "@windtunnel/mcp";
import { buildUi, startViewer, uiStatus } from "@windtunnel/viewer";
import { type Host, HOSTS, install } from "./install.ts";
import { formatScan, scan } from "./scan.ts";
import { PLUGIN_DIR, writeSkills } from "./skills.ts";

export interface Flags {
  cwd?: string;
  ref?: string;
  patch?: string;
  "keep-db"?: boolean;
  all?: boolean;
  repeat?: string;
  trace?: string;
  headed?: boolean;
  seam?: string;
  limit?: string;
  json?: boolean;
  focus?: string;
  base?: string;
  "base-patch"?: string;
  "no-schema"?: boolean;
  out?: string;
  prefix?: string;
  affected?: boolean;
  branch?: string;
  message?: string;
  crawl?: boolean;
  users?: string;
  "no-triage"?: boolean;
  port?: string;
  "no-open"?: boolean;
  yes?: boolean;
  "dry-run"?: boolean;
  hosts?: string;
  image?: string;
  help?: boolean;
}

const HELP = `windtunnel — real-world failure experiments for web apps

Usage: windtunnel <command> [options]

Commands
  install             Set up the coding agents found here (Claude Code, Codex, Muse Code) and check
                      Docker, Postgres and Playwright's Chromium; asks once before changing anything
  run [experiment…]   Run experiments (default: all in .windtunnel/experiments)
  affected [exp…]     Which experiments the working tree's changes affect, and why (runs nothing)
  validate [exp…]     Check experiment files and flows, and run the rules on the seed data
  runs                List recent runs
  evidence <run>[/<n>/<part>]
                      Evidence packet for a run, or one detail (steps, requests, diff[:table], rule:<id>, log…)
  map                 App map from the code: handlers, risky patterns, pages, database schema
                      (plus the live crawl of this code version, if there is one)
  scan                What in a Next.js app's code is worth an experiment, in plain words; any folder,
                      no config, build or database needed
  crawl               Run the app and crawl it as a visitor and test users: real control names, and the
                      free sweep (console errors, failed requests, broken links, accessibility, slow pages)
  decide [id] [answer…]
                      Open decisions Wind Tunnel handed back, or answer one (an option id, or Playwright code
                      for a selector decision)
  usage               What Wind Tunnel returned to agents per job, and what small-model decisions cost
  prove <experiment…> Prove a fix: fails on --base (default HEAD), passes on the working tree (or --patch)
                      in every ordering, fails again on the base, other experiments don't get worse
  view                Local viewer in the browser: runs, aligned timelines, first divergence, trace chain,
                      database changes, rules, usage; Run hunt (Muse Code) and Open in Claude Code
  mcp                 MCP server on stdin/stdout for coding agents (Claude Code, Codex, Muse Code)
  skills --out <dir>  Copy the agent skills (init, hunt, prove, test) into <dir>, e.g. .agents/skills
  doctor              Check Node, git, the config file and the database (and the Android tools, for phone apps)
  devices [create|stop]
                      The Android emulators phone apps run on: list them, create the AVD (windtunnel-34,
                      from Android's image for automated tests), or stop the ones still running
  prepare             Check out, install and build a code version, and seed its snapshot
  branch              Start an isolated branch (app + database copy + data folder) and keep it running
  clean               Stop leftover app processes, drop run databases and remove data folders

Options
  --cwd <dir>         Project folder (default: current folder)
  --ref <git ref>     Code version to use (default: the working tree, uncommitted changes included)
  --patch <file>      Unified diff applied on top of the code version
  --repeat <n>        (run) repetitions per variant, overriding the experiment's repeat
  --affected          (run) only experiments whose code changed since their last result; reuse the rest
  --no-triage         (run) don't sort failures or heal renamed locators in flow files
  --trace <mode>      (run) Playwright traces: failures (default: runs that broke a rule or errored), on, off
  --headed            (run) show the browser
  --seam <where>      (run) where the browser's calls are caught: route (default: Playwright's routes) or
                      proxy (an HTTP proxy in front of the app, as phone apps always use)
  --keep-db           (run, branch) keep run databases after stopping
  --limit <n>         (runs) how many to list (default 20)
  --focus <text>      (map) only routes and pages whose path or file contains this
  --no-schema         (map) skip the database schema (no build or database needed)
  --crawl             (map) crawl the running app first (see crawl)
  --users <a,b>       (crawl) test users to crawl as, besides an anonymous visitor (default: crawl.users,
                      else the first user)
  --base <git ref>    (prove) code with the bug (default HEAD)
  --branch <name>     (prove) when proven, create this branch: the fix + the experiments as regression
                      tests + .windtunnel/evidence/<id>.md (the working tree is not touched)
  --message <text>    (prove --branch) commit message (default: generated from the proof)
  --prefix <text>     (skills) prefix for skill names, e.g. windtunnel-
  --base-patch <file> (prove) diff applied to --base (default: the working tree) to get the code with
                      the bug; the fix is then --base itself unless --patch is given
  --port <n>          (view) port on 127.0.0.1 (default 4477, or the next free one)
  --no-open           (view) don't open the browser
                      (view --json: print the address and token as one line of JSON for the Mac app,
                      without a browser; it stops when its stdin closes)
  --all               (clean) also drop snapshots and delete worktrees
  --yes, -y           (install) don't ask before making changes
  --dry-run           (install) only show what would be done
  --hosts <a,b>       (install) only these agents: claude, codex, muse (default: every one found)
  --image <id>        (devices create) system image, e.g. system-images;android-34;google_atd;arm64-v8a
  --json              Machine-readable output
`;

export async function main(args: string[], flags: Flags): Promise<number> {
  const [command] = args;
  if (!command || flags.help) {
    process.stdout.write(HELP);
    return command || flags.help ? 0 : 1;
  }
  try {
    switch (command) {
      case "run":
        return await run(args.slice(1), flags);
      case "affected":
        return await affected(args.slice(1), flags);
      case "validate":
        return await validate(args.slice(1), flags);
      case "runs":
        return await runs(flags);
      case "evidence":
        return await evidence(args.slice(1), flags);
      case "map":
        return await map(flags);
      case "scan": {
        const result = await scan(flags.cwd ?? process.cwd());
        print(flags, result, formatScan(result));
        return 0;
      }
      case "crawl":
        return await crawlCommand(flags);
      case "decide":
        return await decide(args.slice(1), flags);
      case "usage":
        return await usage(flags);
      case "prove":
        return await proveCommand(args.slice(1), flags);
      case "skills":
        return await skills(flags);
      case "install":
        return await install({ yes: flags.yes, dryRun: flags["dry-run"], hosts: hostsFlag(flags.hosts), json: flags.json });
      case "mcp":
        await serveStdio(mcpDir(flags));
        return 0;
      case "view":
        return await view(flags);
      case "doctor":
        return await doctor(flags);
      case "prepare":
        return await prepare(flags);
      case "branch":
        return await branch(flags);
      case "clean":
        return await cleanCommand(flags);
      case "devices":
        return await devices(args[1], flags);
      default:
        process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    // Expected problems (config, git) read better without a stack trace.
    const message = err instanceof ConfigError || (err as Error).name === "GitError" ? (err as Error).message : ((err as Error).stack ?? String(err));
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

function hostsFlag(value: string | undefined): Host[] | undefined {
  if (value === undefined) return undefined;
  const hosts = value.split(",").map((h) => h.trim());
  const unknown = hosts.filter((h) => !(HOSTS as readonly string[]).includes(h));
  if (unknown.length) throw new ConfigError(`--hosts: unknown agent ${unknown.join(", ")} (claude, codex, muse)`);
  return hosts as Host[];
}

/**
 * The folder the MCP server looks for the app from. Codex starts a plugin's server in the
 * plugin's own folder; the session's folder is then still in PWD.
 */
function mcpDir(flags: Flags): string {
  if (flags.cwd) return resolve(flags.cwd);
  const pluginRoot = process.env.PLUGIN_ROOT;
  const real = (dir: string) => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  if (pluginRoot && process.env.PWD && real(process.cwd()) === real(pluginRoot)) return process.env.PWD;
  return process.cwd();
}

async function versionSpec(flags: Flags): Promise<CodeVersionSpec> {
  return {
    ref: flags.ref,
    patch: flags.patch ? await readFile(resolve(flags.patch), "utf8") : undefined,
  };
}

/** Counts what the CLI prints for the project, as agents often read it (one job per day, or $WINDTUNNEL_JOB). */
let meter: UsageMeter | undefined;
const started = Date.now();

function print(flags: Flags, data: unknown, text: string): void {
  const out = flags.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`;
  process.stdout.write(out);
  void meter?.tool(`cli ${process.argv[2] ?? ""}`.trim(), out, Date.now() - started).catch(() => undefined);
}

/** Progress lines on stderr: only for a person at a terminal (agents read the result). */
function live(flags: Flags): boolean {
  return !flags.json && !!process.stderr.isTTY;
}

async function metered(stateDir: string): Promise<UsageMeter> {
  meter = UsageMeter.forCli(stateDir);
  await meter.load();
  return meter;
}

async function doctor(flags: Flags): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    ok: major > 22 || (major === 22 && minor >= 18),
    detail: `v${process.versions.node} (need 22.18+)`,
  });

  const browser = chromiumStatus();
  checks.push({ name: "chromium", ok: browser.installed, detail: browser.installed ? browser.path : "not downloaded: windtunnel install (or npx playwright install chromium)" });

  let branches: Branches | undefined;
  try {
    const project = await openProject(flags.cwd);
    checks.push({ name: "config", ok: true, detail: project.configPath });
    checks.push({ name: "git", ok: true, detail: project.repoRoot });
    if (project.config.android) checks.push(...(await androidChecks(project.root, project.config.android.avd)));
    if (project.config.app.kind === "tauri") {
      const webkit = browserStatus("tauri");
      checks.push({ name: "webkit", ok: webkit.installed, detail: webkit.installed ? webkit.path : "not downloaded: npx playwright install webkit" });
      const cargo = await runScript("cargo --version", { cwd: project.root, timeoutMs: 15_000 }).catch(() => undefined);
      checks.push({ name: "cargo", ok: cargo?.code === 0, detail: cargo?.code === 0 ? cargo.stdout.trim() : "not found: install Rust (https://rustup.rs)" });
    }
    branches = new Branches(project);
    const db = project.config.db;
    if (branches.pg) checks.push({ name: "postgres", ok: true, detail: `server ${await branches.pg.ping()}` });
    else checks.push({ name: "database", ok: true, detail: db ? `sqlite, ${db.kind === "sqlite" ? db.file : ""} in each run's data folder` : "none (db is not set)" });
  } catch (err) {
    checks.push({ name: branches ? "postgres" : "config", ok: false, detail: (err as Error).message });
  } finally {
    await branches?.pg?.close();
  }

  print(flags, checks, checks.map((c) => `${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(9)} ${c.detail}`).join("\n"));
  return checks.every((c) => c.ok) ? 0 : 1;
}

/** What phone apps need: the SDK, the AVD, Java for Gradle, and Appium with its Android driver. */
async function androidChecks(root: string, avd: string): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const sdk = await findAndroidSdk();
  checks.push({ name: "android", ok: !!sdk, detail: sdk ? sdk.root : "no SDK: install Android Studio, or set ANDROID_HOME" });
  if (sdk) {
    const avds = await listAvds();
    const image = await systemImageDir(sdk, DEFAULT_IMAGE);
    checks.push({
      name: "avd",
      ok: avds.includes(avd),
      detail: avds.includes(avd)
        ? `${avd} (${avdHome()})`
        : `${avd} missing: windtunnel devices create${image ? "" : ` (after installing ${DEFAULT_IMAGE} with Android Studio's SDK Manager)`}`,
    });
    const running = await runningEmulators(sdk, avd);
    checks.push({ name: "phones", ok: true, detail: running.length ? `running: ${running.join(", ")}` : "none running (the first run starts them)" });
  }
  const java = await runScript("java -version 2>&1 | head -1", { cwd: root, timeoutMs: 15_000 }).catch(() => undefined);
  checks.push({ name: "java", ok: java?.code === 0 && /version/.test(java.stdout), detail: java?.code === 0 ? java.stdout.trim() : "not found: Gradle needs a JDK (17 or newer)" });
  const appium = await findAppium(root);
  const driver = appium && (await stat(resolve(appium.home, "node_modules", "appium-uiautomator2-driver")).then(() => true, () => false));
  checks.push({
    name: "appium",
    ok: !!driver,
    detail: driver ? `${appium.home}/node_modules (UiAutomator2 driver)` : "not installed: npm i -D appium appium-uiautomator2-driver webdriverio",
  });
  return checks;
}

/** `windtunnel devices`: the emulators Wind Tunnel runs phones on. */
async function devices(action: string | undefined, flags: Flags): Promise<number> {
  const sdk = await findAndroidSdk();
  if (!sdk) throw new ConfigError("no Android SDK found: install Android Studio, or set ANDROID_HOME");
  const project = await openProject(flags.cwd).catch(() => undefined);
  const avd = project?.config.android?.avd ?? DEFAULT_AVD;
  if (action === "create") {
    const image = flags.image ?? DEFAULT_IMAGE;
    if (!(await systemImageDir(sdk, image))) {
      const installed = await listSystemImages(sdk);
      throw new ConfigError(`${image} is not installed (installed: ${installed.join(", ") || "none"}); add it with Android Studio's SDK Manager, or pass --image`);
    }
    const dir = await createAvd(sdk, avd, image);
    print(flags, { avd, image, dir }, `created ${avd} from ${image}\n  ${dir}\nThe first run boots it once to make the snapshot runs start from.`);
    return 0;
  }
  if (action === "stop") {
    const running = await runningEmulators(sdk);
    for (const serial of running) await stopEmulator(sdk, serial);
    print(flags, { stopped: running }, running.length ? `stopped ${running.join(", ")}` : "no emulators running");
    return 0;
  }
  if (action) throw new ConfigError(`devices ${action}: use create or stop, or nothing to list`);
  const avds = await listAvds();
  const running = await runningEmulators(sdk);
  const data = { sdk: sdk.root, avd, created: avds.includes(avd), avds, running };
  print(
    flags,
    data,
    [
      `sdk      ${sdk.root}`,
      `avd      ${avd}${avds.includes(avd) ? "" : " (not created: windtunnel devices create)"}`,
      `running  ${running.length ? running.join(", ") : "none"}`,
    ].join("\n"),
  );
  return 0;
}

async function prepare(flags: Flags): Promise<number> {
  const branches = await Branches.open(flags.cwd);
  try {
    const started = Date.now();
    const prepared = await branches.prepare(await versionSpec(flags));
    const marker = await branches.versions.readMarker(prepared.version.id);
    const data = { ...prepared, timings: marker?.timings, totalMs: Date.now() - started };
    print(
      flags,
      data,
      [
        `version   ${prepared.version.id} (${prepared.version.label})`,
        `commit    ${prepared.version.commit}`,
        `worktree  ${prepared.worktree}`,
        `snapshot  ${seedSnapshot(branches, prepared.version.id)}`,
        `took      ${Date.now() - started} ms`,
      ].join("\n"),
    );
    return 0;
  } finally {
    await branches.close();
  }
}

/** The seed snapshot `prepare` built: a template database, a SQLite file, or none. */
function seedSnapshot(branches: Branches, versionId: string): string {
  const kind = branches.project.config.db?.kind;
  if (kind === "postgres") return branches.snapshotName(versionId);
  if (kind === "sqlite") return branches.sqliteSnapshot(versionId);
  return "none (no database)";
}

async function branch(flags: Flags): Promise<number> {
  const branches = await Branches.open(flags.cwd);
  stopOnSignals(() => branches.close());
  const started = Date.now();
  const b = await branches.create(await versionSpec(flags), { keepDatabase: flags["keep-db"] });
  print(
    flags,
    { ...b.info(), payments: b.payments?.url, startedInMs: Date.now() - started },
    [
      `branch    ${b.id}`,
      `version   ${b.version.id} (${b.version.label})`,
      `app       ${b.baseUrl}`,
      `database  ${describeDatabase(b.database)}`,
      `data      ${b.dataDir}`,
      ...(b.proxy ? [`app itself ${b.appUrl}`] : []),
      ...(b.payments ? [`payments  ${b.payments.url}`] : []),
      `logs      ${b.logDir}`,
      `ready in  ${Date.now() - started} ms. Press Ctrl-C to stop.`,
    ].join("\n"),
  );
  await new Promise(() => undefined);
  return 0;
}

async function cleanCommand(flags: Flags): Promise<number> {
  const branches = await Branches.open(flags.cwd);
  try {
    const result = await clean(branches, { all: flags.all });
    print(
      flags,
      result,
      `stopped ${result.processes} process(es), dropped ${result.databases.length} database(s), removed ${result.dataDirs} data folder(s) and ${result.worktrees} worktree(s)`,
    );
    return 0;
  } finally {
    await branches.close();
  }
}

async function run(ids: string[], flags: Flags): Promise<number> {
  const trace = flags.trace ?? "failures";
  if (!["off", "failures", "on"].includes(trace)) throw new ConfigError(`--trace must be off, failures or on`);
  if (flags.seam !== undefined && flags.seam !== "route" && flags.seam !== "proxy") throw new ConfigError("--seam must be route or proxy");
  const repeat = flags.repeat === undefined ? undefined : Number(flags.repeat);
  if (repeat !== undefined && !(Number.isInteger(repeat) && repeat >= 1 && repeat <= 100)) {
    throw new ConfigError("--repeat must be a whole number from 1 to 100");
  }
  const runner = await Runner.open(flags.cwd);
  stopOnSignals(() => runner.close());
  const usageMeter = await metered(runner.project.stateDir);
  try {
    const all = await loadExperiments(runner.project, ids);
    if (all.length === 0) throw new ConfigError(`no experiments in ${runner.project.stateDir}/experiments`);
    if (flags.affected && (flags.ref || flags.patch)) throw new ConfigError("--affected works on the working tree only (no --ref or --patch)");
    const statuses = flags.affected ? await findAffected(runner, all, { repeat }) : undefined;
    const experiments = statuses ? all.filter((e) => statuses.find((s) => s.experiment === e.id)?.status !== "cached") : all;
    const version = await versionSpec(flags);
    const decider = Decider.forProject(runner.project, usageMeter);
    const results = experiments.length === 0 ? [] : await runner.run(experiments, {
      version,
      repeat,
      trace: trace as TraceMode,
      headed: flags.headed,
      ...(flags.seam ? { seam: flags.seam as Seam } : {}),
      keepDatabase: flags["keep-db"],
      onRep: live(flags)
        ? (r) => process.stderr.write(`  ${r.outcome.padEnd(6)} ${r.experiment}${r.variant === "default" ? "" : ` [${r.variant}]`} #${r.rep}  ${r.durationMs} ms\n`)
        : undefined,
    });
    const failing = results.filter((r) => r.outcome !== "pass");
    const sorted = failing.length && !flags["no-triage"]
      ? await sortFailures(runner, failing, experiments, {
          decider,
          decisions: new DecisionStore(runner.project.stateDir),
          version,
          onProgress: live(flags) ? (m) => process.stderr.write(`  ${m}\n`) : undefined,
        })
      : [];
    const tail = `${sorted.length ? `\n\n${formatTriage(sorted, decider.chain)}` : ""}\n\n${formatUsage(usageMeter.totals(), runner.project.config.budget)}`;
    // Where things stand: a healed experiment by its re-run.
    const final = afterTriage(results, sorted);
    if (statuses) {
      const cached = statuses.filter((s) => s.status === "cached");
      print(flags, { results: final, cached, triage: sorted }, `\n${formatAffectedRun(statuses, final)}${tail}`);
      return [...final.map((r) => r.outcome), ...cached.map((c) => c.last!.outcome)].every((o) => o === "pass") ? 0 : 1;
    }
    print(flags, { results: final, triage: sorted }, `\n${formatResults(final)}${tail}`);
    return final.every((r) => r.outcome === "pass") ? 0 : 1;
  } finally {
    await runner.close();
  }
}

async function affected(ids: string[], flags: Flags): Promise<number> {
  const runner = await Runner.open(flags.cwd);
  try {
    const experiments = await loadExperiments(runner.project, ids);
    const repeat = flags.repeat === undefined ? undefined : Number(flags.repeat);
    const statuses = await findAffected(runner, experiments, { repeat });
    print(flags, statuses.map(({ last, ...s }) => ({ ...s, lastRun: last?.runId, lastOutcome: last?.outcome })), formatAffected(statuses));
    return 0;
  } finally {
    await runner.close();
  }
}

async function validate(ids: string[], flags: Flags): Promise<number> {
  const runner = await Runner.open(flags.cwd);
  try {
    const experiments = await loadExperiments(runner.project, ids);
    const { rules, warnings } = await runner.validate(experiments);
    const problems = await runner.checkRulesOnSeed(rules, await versionSpec(flags));
    if (problems.length) throw new ConfigError(problems.join("\n"));
    print(
      flags,
      { ok: true, experiments: experiments.map((e) => e.id), rules: rules.map((r) => r.id), warnings },
      [`ok: ${experiments.length} experiment(s), ${rules.length} rule(s) hold on the seed data`, ...warnings.map((w) => `warning: ${w}`)].join("\n"),
    );
    return 0;
  } finally {
    await runner.close();
  }
}

async function runs(flags: Flags): Promise<number> {
  const runner = await Runner.open(flags.cwd);
  try {
    const entries = await runner.store.list(flags.limit ? Number(flags.limit) : 20);
    print(
      flags,
      entries,
      entries.length === 0
        ? "no runs yet"
        : entries.map((e) => `${e.id}  ${e.experiment.padEnd(28)} ${e.version}  ${e.headline}`).join("\n"),
    );
    return 0;
  } finally {
    await runner.close();
  }
}

async function evidence(args: string[], flags: Flags): Promise<number> {
  const [handle] = args;
  if (!handle) throw new ConfigError("usage: windtunnel evidence <run>[/<n>/<part>] (see windtunnel runs)");
  const workspace = new Workspace(flags.cwd ?? process.cwd());
  try {
    await metered((await workspace.open()).project.stateDir);
    const text = await workspace.evidence(handle);
    print(flags, { text }, text);
    return 0;
  } finally {
    await workspace.close();
  }
}

async function map(flags: Flags): Promise<number> {
  const branches = await Branches.open(await findProjectDir(flags.cwd ?? process.cwd()));
  try {
    const schema = flags["no-schema"] ? undefined : await branches.withSeedCopy(await versionSpec(flags), seedSchema);
    const appMap = await buildAppMap(branches.project, { schema });
    await metered(branches.project.stateDir);
    const version = await branches.versions.resolve(await versionSpec(flags));
    let found: Awaited<ReturnType<typeof readCrawl>> = await readCrawl(branches.project, version);
    if (flags.crawl) {
      const runner = new Runner(branches);
      const onProgress = live(flags) ? (m: string) => process.stderr.write(`  ${m}\n`) : undefined;
      found = { ...(await crawl(runner, { version: await versionSpec(flags), users: flags.users?.split(","), onProgress })), stale: false };
    }
    const text = [
      formatAppMap(appMap, { focus: flags.focus, maxChars: flags.json ? undefined : 1_000_000 }),
      found ? formatCrawl(found, 1_000_000, flags.focus) : "(no live crawl yet: windtunnel crawl, or map --crawl)",
    ].join("\n\n");
    print(flags, { ...appMap, crawl: found }, text);
    return 0;
  } finally {
    await branches.close();
  }
}

async function crawlCommand(flags: Flags): Promise<number> {
  const runner = await Runner.open(flags.cwd);
  stopOnSignals(() => runner.close());
  try {
    await metered(runner.project.stateDir);
    const result = await crawl(runner, {
      version: await versionSpec(flags),
      users: flags.users?.split(","),
      onProgress: live(flags) ? (m) => process.stderr.write(`  ${m}\n`) : undefined,
    });
    print(flags, result, `${formatCrawl(result, 1_000_000)}\n\n${formatSweep(result.sweep, 1_000)}`);
    return 0;
  } finally {
    await runner.close();
  }
}

async function decide(args: string[], flags: Flags): Promise<number> {
  const [id, ...words] = args;
  const runner = await Runner.open(flags.cwd);
  stopOnSignals(() => runner.close());
  try {
    await metered(runner.project.stateDir);
    const store = new DecisionStore(runner.project.stateDir);
    if (!id) {
      const open = await store.open();
      print(flags, open, open.length ? open.map(formatDecision).join("\n\n") : "no open decisions");
    } else if (words.length === 0) {
      const d = await store.get(id);
      print(flags, d, formatDecision(d));
    } else {
      const text = await answerDecision(runner, store, id, words.join(" "), await loadExperiments(runner.project));
      print(flags, { id, result: text }, text);
    }
    return 0;
  } finally {
    await runner.close();
  }
}

async function usage(flags: Flags): Promise<number> {
  const project = await openProject(flags.cwd);
  const jobs = await listUsage(project.stateDir, flags.limit ? Number(flags.limit) : 20);
  print(flags, jobs, jobs.length ? jobs.map((t) => formatUsage(t)).join("\n") : "no usage recorded yet");
  return 0;
}

async function proveCommand(ids: string[], flags: Flags): Promise<number> {
  if (ids.length === 0) throw new ConfigError("usage: windtunnel prove <experiment…> [--base <ref>] [--patch <fix.patch>] [--repeat <n>]");
  const workspace = new Workspace(flags.cwd ?? process.cwd());
  const runner = await workspace.open();
  stopOnSignals(() => workspace.close());
  try {
    const all = await loadExperiments(runner.project);
    const repeat = flags.repeat === undefined ? undefined : Number(flags.repeat);
    // With --base-patch the bug is a diff on top of --base (default: the working tree), and the fix is --base itself.
    const basePatch = flags["base-patch"] ? await readFile(resolve(flags["base-patch"]), "utf8") : undefined;
    const at = flags.base ? { ref: flags.base } : basePatch ? {} : { ref: "HEAD" };
    if (flags.branch && basePatch) throw new ConfigError("--branch needs the bug to be in --base (a commit), not in --base-patch");
    const targets = await loadExperiments(runner.project, ids);
    const proof = await prove(runner, {
      experiments: targets,
      base: { ...at, ...(basePatch ? { patch: basePatch } : {}) },
      fix: flags.patch ? { ...at, patch: await readFile(resolve(flags.patch), "utf8") } : basePatch ? at : {},
      repeat,
      regression: all.filter((e) => !ids.includes(e.id)),
      reuse: !!flags.branch,
    });
    let text = formatProof(proof);
    let branch: Awaited<ReturnType<typeof writeProofBranch>> | undefined;
    if (flags.branch && proof.verdict === "proven") {
      branch = await writeProofBranch(runner, proof, {
        name: flags.branch,
        parent: flags.base ?? "HEAD",
        experiments: targets,
        rules: await workspace.rules(),
        handlerFor: await workspace.handlerResolver().catch(() => undefined),
        message: flags.message,
      });
      text += `\n\n${formatBranch(branch)}`;
    } else if (flags.branch) text += "\n\nNo branch created: the fix is not proven.";
    print(flags, { ...proof, branch }, `${text}\n\n${formatUsage((await metered(runner.project.stateDir)).totals(), runner.project.config.budget)}`);
    return proof.verdict === "proven" ? 0 : 1;
  } finally {
    await workspace.close();
  }
}

function formatBranch(b: { name: string; commit: string; added: string[]; evidenceCopy: string; remote?: string }): string {
  return [
    `Branch ${b.name} created (${b.commit.slice(0, 12)}): the fix${b.added.length ? " plus" : ""}`,
    ...b.added.map((f) => `  ${f}`),
    b.remote ? `Push it: git push -u ${b.remote} ${b.name}` : "No git remote is set up, so there is nowhere to push it yet.",
    `PR text: ${b.evidenceCopy}`,
  ].join("\n");
}

async function skills(flags: Flags): Promise<number> {
  if (!flags.out) throw new ConfigError("usage: windtunnel skills --out <dir> [--prefix windtunnel-]");
  const written = await writeSkills(flags.out, flags.prefix ?? "");
  print(flags, written, written.map((w) => `wrote ${w}`).join("\n"));
  return 0;
}

/**
 * Serves the viewer until Ctrl-C; a viewer already running for the project is reused. With --json
 * (the Mac app): one line of JSON with the address and token, no browser or web UI build, and it
 * stops when its stdin closes (the app quit).
 */
async function view(flags: Flags): Promise<number> {
  const dir = await findProjectDir(flags.cwd ? resolve(flags.cwd) : process.cwd());
  const project = await openProject(dir);
  const running = await runningViewer(project.stateDir);
  if (running && !flags.port) {
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ url: running.url, port: running.port, token: running.token, pid: running.pid, root: project.root, reused: true })}\n`);
      return 0;
    }
    const url = `${running.url}/?token=${running.token}`;
    process.stdout.write(`The viewer for this project is already running (pid ${running.pid}):\n  ${url}\n`);
    if (!flags["no-open"]) openBrowser(url);
    return 0;
  }
  if (!flags.json) {
    const ui = await uiStatus();
    if (ui !== "ok") {
      process.stderr.write(ui === "missing" ? "Building the viewer (once)…\n" : "The viewer's UI changed: rebuilding…\n");
      await buildUi();
    }
  }
  const port = flags.port === undefined ? undefined : Number(flags.port);
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new ConfigError(`--port: not a port: ${flags.port}`);
  const viewer = await startViewer({
    cwd: dir,
    ...(port !== undefined ? { port } : {}),
    // Runs started from the viewer use this same CLI.
    cli: [process.execPath, ...process.execArgv, process.argv[1]!],
    pluginDir: PLUGIN_DIR,
  });
  stopOnSignals(() => viewer.close());
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ url: viewer.url, port: viewer.port, token: viewer.token, pid: process.pid, root: viewer.root, reused: false })}\n`);
    if (!process.stdin.isTTY) {
      const stop = () => void viewer.close().finally(() => process.exit(0));
      process.stdin.once("end", stop).once("close", stop).resume();
    }
    await new Promise(() => undefined);
    return 0;
  }
  process.stdout.write(
    [
      `Wind Tunnel viewer for ${viewer.root}`,
      `  ${viewer.openUrl}`,
      "",
      "Open that link (it signs this browser in to the viewer; other sites can't reach it). Ctrl-C stops it.",
      process.env.MODEL_API_KEY ? "Run hunt: on, billed to the Meta key in this shell (MODEL_API_KEY)." : "Run hunt: off until you start the viewer in the shell with MODEL_API_KEY (scripts/muse-env.sh).",
      "",
    ].join("\n"),
  );
  if (!flags["no-open"]) openBrowser(viewer.openUrl);
  await new Promise(() => undefined);
  return 0;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // No browser to open: the link is printed.
  }
}

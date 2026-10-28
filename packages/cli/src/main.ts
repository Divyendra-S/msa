import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  Branches,
  type CodeVersionSpec,
  clean,
  ConfigError,
  drillDown,
  formatProof,
  formatResults,
  loadExperiments,
  loadRules,
  openProject,
  prove,
  Runner,
  writeProofBranch,
  stopOnSignals,
  type TraceMode,
} from "@windtunnel/core";
import { buildAppMap, findAffected, formatAffected, formatAffectedRun, formatAppMap, readSchema } from "@windtunnel/explorer";
import { findProjectDir, serveStdio, Workspace } from "@windtunnel/mcp";

export interface Flags {
  cwd?: string;
  ref?: string;
  patch?: string;
  "keep-db"?: boolean;
  all?: boolean;
  repeat?: string;
  trace?: string;
  headed?: boolean;
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
  help?: boolean;
}

const HELP = `windtunnel — real-world failure experiments for web apps

Usage: windtunnel <command> [options]

Commands
  run [experiment…]   Run experiments (default: all in .windtunnel/experiments)
  affected [exp…]     Which experiments the working tree's changes affect, and why (runs nothing)
  validate [exp…]     Check experiment files and flows, and run the rules on the seed data
  runs                List recent runs
  evidence <run>[/<n>/<part>]
                      Evidence packet for a run, or one detail (steps, requests, diff[:table], rule:<id>, log…)
  map                 App map from the code: handlers, risky patterns, pages, database schema
  prove <experiment…> Prove a fix: fails on --base (default HEAD), passes on the working tree (or --patch)
                      in every ordering, fails again on the base, other experiments don't get worse
  mcp                 MCP server on stdin/stdout for coding agents (Claude Code, Codex, Muse Code)
  skills --out <dir>  Copy the agent skills (init, hunt, prove, test) into <dir>, e.g. .agents/skills
  doctor              Check Node, git, the config file and Postgres
  prepare             Check out, install and build a code version, and seed its snapshot
  branch              Start an isolated branch (app + database copy) and keep it running
  clean               Stop leftover app processes and drop run databases

Options
  --cwd <dir>         Project folder (default: current folder)
  --ref <git ref>     Code version to use (default: the working tree, uncommitted changes included)
  --patch <file>      Unified diff applied on top of the code version
  --repeat <n>        (run) repetitions per variant, overriding the experiment's repeat
  --affected          (run) only experiments whose code changed since their last result; reuse the rest
  --trace <mode>      (run) Playwright traces: failures (default: runs that broke a rule or errored), on, off
  --headed            (run) show the browser
  --keep-db           (run, branch) keep run databases after stopping
  --limit <n>         (runs) how many to list (default 20)
  --focus <text>      (map) only routes and pages whose path or file contains this
  --no-schema         (map) skip the database schema (no build or database needed)
  --base <git ref>    (prove) code with the bug (default HEAD)
  --branch <name>     (prove) when proven, create this branch: the fix + the experiments as regression
                      tests + .windtunnel/evidence/<id>.md (the working tree is not touched)
  --message <text>    (prove --branch) commit message (default: generated from the proof)
  --prefix <text>     (skills) prefix for skill names, e.g. windtunnel-
  --base-patch <file> (prove) diff applied to --base (default: the working tree) to get the code with
                      the bug; the fix is then --base itself unless --patch is given
  --all               (clean) also drop snapshots and delete worktrees
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
      case "prove":
        return await proveCommand(args.slice(1), flags);
      case "skills":
        return await skills(flags);
      case "mcp":
        await serveStdio(flags.cwd ? resolve(flags.cwd) : process.cwd());
        return 0;
      case "doctor":
        return await doctor(flags);
      case "prepare":
        return await prepare(flags);
      case "branch":
        return await branch(flags);
      case "clean":
        return await cleanCommand(flags);
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

async function versionSpec(flags: Flags): Promise<CodeVersionSpec> {
  return {
    ref: flags.ref,
    patch: flags.patch ? await readFile(resolve(flags.patch), "utf8") : undefined,
  };
}

function print(flags: Flags, data: unknown, text: string): void {
  process.stdout.write(flags.json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
}

async function doctor(flags: Flags): Promise<number> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    ok: major > 22 || (major === 22 && minor >= 18),
    detail: `v${process.versions.node} (need 22.18+)`,
  });

  let branches: Branches | undefined;
  try {
    const project = await openProject(flags.cwd);
    checks.push({ name: "config", ok: true, detail: project.configPath });
    checks.push({ name: "git", ok: true, detail: project.repoRoot });
    branches = new Branches(project);
    checks.push({ name: "postgres", ok: true, detail: `server ${await branches.pg.ping()}` });
  } catch (err) {
    checks.push({ name: branches ? "postgres" : "config", ok: false, detail: (err as Error).message });
  } finally {
    await branches?.pg.close();
  }

  print(flags, checks, checks.map((c) => `${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(9)} ${c.detail}`).join("\n"));
  return checks.every((c) => c.ok) ? 0 : 1;
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
        `snapshot  ${branches.snapshotName(prepared.version.id)}`,
        `took      ${Date.now() - started} ms`,
      ].join("\n"),
    );
    return 0;
  } finally {
    await branches.close();
  }
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
      `database  ${b.database.url}`,
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
      `stopped ${result.processes} process(es), dropped ${result.databases.length} database(s), removed ${result.worktrees} worktree(s)`,
    );
    return 0;
  } finally {
    await branches.close();
  }
}

async function run(ids: string[], flags: Flags): Promise<number> {
  const trace = flags.trace ?? "failures";
  if (!["off", "failures", "on"].includes(trace)) throw new ConfigError(`--trace must be off, failures or on`);
  const repeat = flags.repeat === undefined ? undefined : Number(flags.repeat);
  if (repeat !== undefined && !(Number.isInteger(repeat) && repeat >= 1 && repeat <= 100)) {
    throw new ConfigError("--repeat must be a whole number from 1 to 100");
  }
  const runner = await Runner.open(flags.cwd);
  stopOnSignals(() => runner.close());
  try {
    const all = await loadExperiments(runner.project, ids);
    if (all.length === 0) throw new ConfigError(`no experiments in ${runner.project.stateDir}/experiments`);
    if (flags.affected && (flags.ref || flags.patch)) throw new ConfigError("--affected works on the working tree only (no --ref or --patch)");
    const statuses = flags.affected ? await findAffected(runner, all, { repeat }) : undefined;
    const experiments = statuses ? all.filter((e) => statuses.find((s) => s.experiment === e.id)?.status !== "cached") : all;
    const results = experiments.length === 0 ? [] : await runner.run(experiments, {
      version: await versionSpec(flags),
      repeat,
      trace: trace as TraceMode,
      headed: flags.headed,
      keepDatabase: flags["keep-db"],
      onRep: flags.json
        ? undefined
        : (r) => process.stderr.write(`  ${r.outcome.padEnd(6)} ${r.experiment}${r.variant === "default" ? "" : ` [${r.variant}]`} #${r.rep}  ${r.durationMs} ms\n`),
    });
    if (statuses) {
      const cached = statuses.filter((s) => s.status === "cached");
      print(flags, { results, cached }, `\n${formatAffectedRun(statuses, results)}`);
      return [...results.map((r) => r.outcome), ...cached.map((c) => c.last!.outcome)].every((o) => o === "pass") ? 0 : 1;
    }
    print(flags, results, `\n${formatResults(results)}`);
    return results.every((r) => r.outcome === "pass") ? 0 : 1;
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
    const runner = await workspace.open();
    const text = await drillDown(runner.store, handle, {
      rules: await loadRules(runner.project).catch(() => []),
      handlerFor: await workspace.handlerResolver().catch(() => undefined),
      source: runner.project,
    });
    process.stdout.write(`${text}\n`);
    return 0;
  } finally {
    await workspace.close();
  }
}

async function map(flags: Flags): Promise<number> {
  const branches = await Branches.open(await findProjectDir(flags.cwd ?? process.cwd()));
  try {
    const schema = flags["no-schema"] ? undefined : await branches.withSeedCopy(await versionSpec(flags), readSchema);
    const appMap = await buildAppMap(branches.project, { schema });
    print(flags, appMap, formatAppMap(appMap, { focus: flags.focus, maxChars: flags.json ? undefined : 1_000_000 }));
    return 0;
  } finally {
    await branches.close();
  }
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
    print(flags, { ...proof, branch }, text);
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

/** The plugin's skills folder: next to the CLI in a checkout of the repository. */
const SKILLS_DIR = join(dirname(import.meta.dirname), "..", "..", "plugins", "windtunnel", "skills");

async function skills(flags: Flags): Promise<number> {
  if (!flags.out) throw new ConfigError("usage: windtunnel skills --out <dir> [--prefix windtunnel-]");
  const prefix = flags.prefix ?? "";
  const written: string[] = [];
  for (const name of (await readdir(SKILLS_DIR)).sort()) {
    const target = join(resolve(flags.out), `${prefix}${name}`);
    await mkdir(target, { recursive: true });
    await cp(join(SKILLS_DIR, name), target, { recursive: true });
    const skill = join(target, "SKILL.md");
    const text = await readFile(skill, "utf8");
    // The skill's own name and references to sibling skills get the prefix too.
    await writeFile(skill, text.replace(/^name: (.+)$/m, `name: ${prefix}$1`).replace(/\b(init|hunt|prove|test) skill\b/g, `${prefix}$1 skill`));
    written.push(target);
  }
  print(flags, written, written.map((w) => `wrote ${w}`).join("\n"));
  return 0;
}

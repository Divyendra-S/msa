import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Branches, type CodeVersionSpec, clean, ConfigError, openProject, stopOnSignals } from "@windtunnel/core";

export interface Flags {
  cwd?: string;
  ref?: string;
  patch?: string;
  "keep-db"?: boolean;
  all?: boolean;
  json?: boolean;
  help?: boolean;
}

const HELP = `windtunnel — real-world failure experiments for web apps

Usage: windtunnel <command> [options]

Commands
  doctor              Check Node, git, the config file and Postgres
  prepare             Check out, install and build a code version, and seed its snapshot
  branch              Start an isolated branch (app + database copy) and keep it running
  clean               Stop leftover app processes and drop run databases

Options
  --cwd <dir>         Project folder (default: current folder)
  --ref <git ref>     Code version to use (default: the working tree, uncommitted changes included)
  --patch <file>      Unified diff applied on top of the code version
  --keep-db           (branch) keep the run database after stopping
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
    const message = err instanceof ConfigError ? err.message : ((err as Error).stack ?? String(err));
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

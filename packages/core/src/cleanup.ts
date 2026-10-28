import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Branches } from "./branches/branches.ts";
import { killPid } from "./exec.ts";
import { isAlive } from "./lock.ts";
import { exists } from "./project.ts";

const execFileAsync = promisify(execFile);

export interface CleanResult {
  processes: number;
  databases: string[];
  worktrees: number;
}

/**
 * Removes what earlier sessions left behind: app processes and run databases.
 * With `all`, also drops seed snapshots and deletes worktrees (forcing rebuilds).
 * Only call this when no other Wind Tunnel session is using the project.
 */
export async function clean(branches: Branches, options: { all?: boolean } = {}): Promise<CleanResult> {
  const { project, pg } = branches;
  const result: CleanResult = { processes: 0, databases: [], worktrees: 0 };

  const pidsDir = join(project.stateDir, "pids");
  if (await exists(pidsDir)) {
    for (const file of await readdir(pidsDir)) {
      const record = JSON.parse(await readFile(join(pidsDir, file), "utf8").catch(() => "{}")) as {
        pid?: number;
        port?: number;
      };
      if (record.pid && isAlive(record.pid) && (await looksLikeOurs(record.pid, record.port))) {
        killPid(record.pid, "SIGKILL");
        result.processes += 1;
      }
      await rm(join(pidsDir, file), { force: true });
    }
  }

  const prefixes = [`${branches.dbPrefix}run_`, ...(options.all ? [`${branches.dbPrefix}seed_`] : [])];
  for (const prefix of prefixes) {
    for (const name of await pg.list(prefix)) {
      await pg.drop(name);
      result.databases.push(name);
    }
  }

  if (options.all) result.worktrees = await branches.versions.removeAll();
  return result;
}

/** Guards against pid reuse: the process must still be the app we started on that port. */
async function looksLikeOurs(pid: number, port: number | undefined): Promise<boolean> {
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)]);
    return port === undefined || stdout.includes(String(port));
  } catch {
    return false;
  }
}

/** Stops branches cleanly on Ctrl-C / SIGTERM before exiting. */
export function stopOnSignals(stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(130);
    stopping = true;
    const timer = setTimeout(() => process.exit(130), 10_000);
    void stop().finally(() => {
      clearTimeout(timer);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

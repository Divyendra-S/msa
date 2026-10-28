import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Cross-process lock using an atomic mkdir. A lock left behind by a dead
 * process is taken over.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, timeoutMs = 10 * 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "pid"), String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(await readFile(join(lockDir, "pid"), "utf8").catch(() => "0"));
      if (owner && !isAlive(owner)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockDir} (held by pid ${owner || "?"})`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

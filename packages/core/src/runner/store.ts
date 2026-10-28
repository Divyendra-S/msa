import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RUNS_DIR = "runs";
const INDEX = "index.jsonl";
const SUMMARY = "run.json";

export interface RunIndexEntry {
  id: string;
  experiment: string;
  version: string;
  startedAt: string;
  outcome: string;
  /** e.g. `fail 3/3 one-order-per-cart` */
  headline: string;
}

/**
 * `.windtunnel/runs/<id>/`: one run = one experiment on one code version, with
 * every variant × repetition under `reps/<n>/`.
 */
export class RunStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = join(stateDir, RUNS_DIR);
  }

  async create(): Promise<{ id: string; dir: string }> {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T]/g, "").slice(2, 14);
    const id = `${stamp.slice(0, 6)}-${stamp.slice(6)}-${randomBytes(2).toString("hex")}`;
    const dir = join(this.dir, id);
    await mkdir(join(dir, "reps"), { recursive: true });
    return { id, dir };
  }

  repDir(runDir: string, rep: number): string {
    return join(runDir, "reps", String(rep));
  }

  async finish(runDir: string, summary: unknown, entry: RunIndexEntry): Promise<void> {
    await writeJson(join(runDir, SUMMARY), summary);
    await appendFile(join(this.dir, INDEX), `${JSON.stringify(entry)}\n`);
  }

  /** Most recent first. */
  async list(limit = 20): Promise<RunIndexEntry[]> {
    const text = await readFile(join(this.dir, INDEX), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunIndexEntry)
      .reverse()
      .slice(0, limit);
  }

  async read(id: string): Promise<unknown> {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad run id: ${id}`);
    const text = await readFile(join(this.dir, id, SUMMARY), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`no finished run ${id} (windtunnel runs lists recent runs)`);
      throw err;
    });
    return JSON.parse(text);
  }

  /** Keeps the newest `keep` runs. */
  async prune(keep = 100): Promise<number> {
    const ids = (await readdir(this.dir, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const old = ids.slice(0, Math.max(0, ids.length - keep));
    for (const id of old) await rm(join(this.dir, id), { recursive: true, force: true });
    if (old.length > 0) {
      const gone = new Set(old);
      const entries = (await this.list(Number.MAX_SAFE_INTEGER)).reverse().filter((e) => !gone.has(e.id));
      await writeFile(join(this.dir, INDEX), entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    }
    return old.length;
  }
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

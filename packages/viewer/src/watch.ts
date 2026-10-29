import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listRuns, type RunStore, USAGE_DIR } from "@windtunnel/core";

export type StoreChange = { type: "runs"; changed: string[] } | { type: "usage" };

/**
 * Watches the run store and the usage logs, which other processes (the CLI, the agent's MCP
 * server) write: a poll a second, only while someone listens.
 */
export class StoreWatcher {
  private timer?: NodeJS.Timeout;
  private runs = new Map<string, string>();
  private usage = "";
  private polling = false;
  private readonly listeners = new Set<(change: StoreChange) => void>();

  private readonly store: RunStore;
  private readonly stateDir: string;
  private readonly intervalMs: number;

  constructor(store: RunStore, stateDir: string, intervalMs = 1_000) {
    this.store = store;
    this.stateDir = stateDir;
    this.intervalMs = intervalMs;
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      void this.poll(true);
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.close();
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async poll(first = false): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const runs = new Map((await listRuns(this.store, 50)).map((r) => [r.id, `${r.outcome}:${r.running?.done ?? ""}/${r.running?.total ?? ""}`]));
      const changed = [...runs].filter(([id, sig]) => this.runs.get(id) !== sig).map(([id]) => id);
      this.runs = runs;
      const usage = await newest(join(this.stateDir, USAGE_DIR));
      const usageChanged = usage !== this.usage;
      this.usage = usage;
      if (first) return;
      if (changed.length) this.emit({ type: "runs", changed });
      if (usageChanged) this.emit({ type: "usage" });
    } catch {
      // The store may be mid-write; the next poll sees it whole.
    } finally {
      this.polling = false;
    }
  }

  private emit(change: StoreChange): void {
    for (const l of this.listeners) l(change);
  }
}

/** The newest file's name, size and time in a folder, as one string that changes when any file is written. */
async function newest(dir: string): Promise<string> {
  let best = "";
  let bestTime = 0;
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const s = await stat(join(dir, f)).catch(() => undefined);
    if (s && s.mtimeMs >= bestTime) {
      bestTime = s.mtimeMs;
      best = `${f}:${s.size}:${s.mtimeMs}`;
    }
  }
  return best;
}

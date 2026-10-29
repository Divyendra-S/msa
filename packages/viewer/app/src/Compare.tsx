import { useEffect, useState } from "react";
import { api, type Comparison, type LaneRef, type RunListEntry } from "./api.ts";
import { Timeline } from "./Timeline.tsx";
import { href } from "./util.ts";

/** Any runs side by side: `#/compare/<run>~<n>,…` (`~0`: the run's most telling repetition). */
export function ComparePage({ lanes, runs, versions }: { lanes: LaneRef[]; runs: RunListEntry[]; versions: Record<string, number> }) {
  const [resolved, setResolved] = useState<LaneRef[] | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const key = lanes.map((l) => `${l.run}~${l.rep}`).join(",");
  const changed = lanes.map((l) => versions[l.run] ?? 0).join(",");

  useEffect(() => {
    let stale = false;
    Promise.all(lanes.map(async (l) => (l.rep > 0 ? l : { run: l.run, rep: (await api.run(l.run)).focus ?? 1 }))).then(
      (r) => !stale && setResolved(r),
      (e: Error) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [key]);

  useEffect(() => {
    if (!resolved?.length) return;
    setError(null);
    api.compare(resolved).then(setComparison, (e: Error) => setError(e.message));
  }, [resolved, changed]);

  const go = (next: LaneRef[]) => {
    location.hash = href({ page: "compare", lanes: next });
  };
  const candidates = runs.filter((r) => !r.running && r.outcome !== "stopped" && !resolved?.some((l) => l.run === r.id)).slice(0, 60);

  return (
    <div className="compare">
      <div className="title-row">
        <h1>Side by side</h1>
        <span className="muted">{lanes.length} runs, steps lined up</span>
        <form
          className="push add-lane"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding && resolved) go([...resolved, { run: adding, rep: 0 }]);
            setAdding("");
          }}
        >
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Run to add">
            <option value="">Add a run…</option>
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.experiment} · {r.headline} · {r.id}
              </option>
            ))}
          </select>
          <button type="submit" className="btn small" disabled={!adding || lanes.length >= 8}>
            Add
          </button>
        </form>
      </div>
      {error && <div className="error-line">{error}</div>}
      {!comparison && !error && <div className="loading">Lining up the runs…</div>}
      {comparison && resolved && <Timeline comparison={comparison} lanes={resolved} onRemove={(i) => go(resolved.filter((_, j) => j !== i))} />}
    </div>
  );
}

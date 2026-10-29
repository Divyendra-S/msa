import type { RunListEntry } from "./api.ts";
import { ago, batches, clock, day, href, tone } from "./util.ts";

export function RunsList({ runs, selected }: { runs: RunListEntry[] | null; selected?: string }) {
  if (!runs) return <div className="side-note">Loading runs…</div>;
  if (runs.length === 0) return <div className="side-note">No runs yet.</div>;
  return (
    <nav className="runs" aria-label="Runs">
      {batches(runs).map((b) => {
        const lanes = b.runs.filter((r) => !r.running && r.outcome !== "stopped");
        return (
          <section key={b.key} className="batch">
            <header>
              <span title={b.startedAt}>
                {day(b.startedAt)} {clock(b.startedAt)}
              </span>
              <span className="muted">{ago(b.startedAt)}</span>
              {lanes.length > 1 && (
                <a className="link small" href={href({ page: "compare", lanes: lanes.slice(0, 8).map((r) => ({ run: r.id, rep: 0 })) })} title="Line up the experiments of this batch side by side">
                  compare
                </a>
              )}
            </header>
            <ul>
              {b.runs.map((r) => (
                <li key={r.id}>
                  <a className={`run-item ${selected === r.id ? "selected" : ""}`} href={href({ page: "run", id: r.id })}>
                    <span className={`dot ${tone(r.outcome)}`} />
                    <span className="run-name">{r.experiment}</span>
                    <span className={`run-head ${tone(r.outcome)}`}>
                      {r.running ? (
                        <>
                          <span className="spin" /> {r.running.done}/{r.running.total}
                        </>
                      ) : (
                        r.headline
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

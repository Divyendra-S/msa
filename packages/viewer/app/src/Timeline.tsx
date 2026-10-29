import type { Comparison, LaneRef, LaneStep } from "./api.ts";
import { href, ms, tone } from "./util.ts";

type Request = LaneStep["requests"][number];

/**
 * Runs side by side, one column each, their steps lined up by tab and step name. Each cell
 * shows when the step ran (on one time scale for all lanes) and the requests it sent; the
 * first difference from the lane that held every rule is marked.
 */
export function Timeline({
  comparison,
  lanes,
  compareHref,
  onRemove,
}: {
  comparison: Comparison;
  lanes: LaneRef[];
  compareHref?: string;
  onRemove?: (i: number) => void;
}) {
  const { rows, divergence, reference } = comparison;
  const end = Math.max(1, ...rows.flatMap((r) => r.cells.flatMap((c) => (c ? [c.end, ...c.requests.map((q) => q.end ?? q.start)] : []))));
  const firstRows = new Set(divergence.flatMap((d) => (d ? [d.row] : [])));
  const columns = `minmax(9rem, 13rem) repeat(${comparison.lanes.length}, minmax(15rem, 1fr))`;

  return (
    <div className="timeline">
      <div className="tl-legend">
        <span>
          Steps lined up by tab and name; bars on one clock (0 – {ms(end)}).
        </span>
        {comparison.lanes.length > 1 &&
          (reference >= 0 ? (
            <span>
              <span className="swatch first" /> first difference from the run that held every rule
            </span>
          ) : (
            <span className="muted">No lane held every rule, so there is nothing to diverge from.</span>
          ))}
        {compareHref && (
          <a className="link" href={compareHref}>
            Open side by side, add runs →
          </a>
        )}
      </div>
      <div className="tl-scroll">
        <div className="tl-grid" style={{ gridTemplateColumns: columns }}>
          <div className="tl-corner" />
          {comparison.lanes.map((l, i) => (
            <div key={`${l.run}/${l.rep}`} className={`tl-lane-head ${tone(l.outcome)}`}>
              <div className="lane-top">
                <span className={`pill ${tone(l.outcome)}`}>{l.outcome}</span>
                {i === reference && <span className="pill good outline" title="The lane the others are compared with">held every rule</span>}
                {onRemove && comparison.lanes.length > 1 && (
                  <button type="button" className="x" onClick={() => onRemove(i)} aria-label="Remove this lane">
                    ×
                  </button>
                )}
              </div>
              <a className="lane-name" href={href({ page: "run", id: l.run, rep: l.rep })}>
                {l.experiment} <span className="muted">#{l.rep}</span>
              </a>
              <div className="lane-meta">
                {l.variant !== "default" && <span className="mono">[{l.variant}]</span>}
                <span>{ms(l.durationMs)}</span>
                {l.diff && <span className="mono">{l.diff}</span>}
              </div>
              {l.broken.length > 0 && <div className="lane-broken">broke {l.broken.join(", ")}</div>}
              {l.error && <div className="lane-error">{l.error}</div>}
              {lanes[i] && divergence[i] && <div className="lane-first">differs at row {divergence[i]!.row + 1}</div>}
            </div>
          ))}
          {rows.map((row, r) => {
            const sigs = row.cells.map((c) => (c ? c.requests.map(sig).join("|") + (c.error ? "!" : "") : null));
            const present = sigs.filter((s): s is string => s !== null);
            // Rows only some lanes have (another tab, another flow) aren't differences worth flagging.
            const differs = present.length > 1 && new Set(present).size > 1;
            return [
              <div key={`l${r}`} className={`tl-row-label ${firstRows.has(r) ? "first" : differs ? "differs" : ""}`}>
                <span className="tab-chip">{row.tab}</span>
                <span className="step-name">{row.step}</span>
                {row.attempt && <span className="muted small">({row.attempt})</span>}
              </div>,
              ...row.cells.map((c, i) => (
                <div key={`c${r}-${i}`} className={`tl-cell ${c ? "" : "none"} ${firstRows.has(r) && divergence[i]?.row === r ? "first" : ""}`}>
                  {c ? <Cell cell={c} end={end} /> : <span className="muted small">not in this run</span>}
                </div>
              )),
            ];
          })}
        </div>
      </div>
      {divergence.some(Boolean) && (
        <ul className="tl-firsts">
          {divergence.map((d, i) =>
            d ? (
              <li key={i}>
                <b>
                  {comparison.lanes[i]!.experiment} #{comparison.lanes[i]!.rep}
                </b>{" "}
                first differs in tab <b>{d.tab}</b> at {ms(d.at)}: <code className="bad-text">{d.ours}</code> where the passing run had{" "}
                <code className="good-text">{d.theirs}</code>
              </li>
            ) : null,
          )}
        </ul>
      )}
    </div>
  );
}

function Cell({ cell, end }: { cell: LaneStep; end: number }) {
  const left = (cell.start / end) * 100;
  const width = Math.max(0.6, ((cell.end - cell.start) / end) * 100);
  return (
    <>
      <div className="track" title={`${ms(cell.start)} – ${ms(cell.end)} (${ms(cell.end - cell.start)})`}>
        <span className={`bar ${cell.error ? "bad" : ""}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
      </div>
      <div className="cell-meta">
        <span className="mono">
          {cell.start}–{cell.end} ms
        </span>
        {cell.as && <span className="pill outline">as {cell.as}</span>}
        {!cell.quiet && <span className="muted small" title="The network never went quiet after this step">busy</span>}
        {cell.writes !== undefined && cell.requests.every((q) => !q.sql) && (
          <span className="writes" title="Deliveries overlapped, so their writes can't be told apart">
            {cell.writes} writes
          </span>
        )}
      </div>
      {cell.harness.map((h) => (
        <div key={h} className="harness">
          {h}
        </div>
      ))}
      {cell.requests.map((q) => (
        <div key={q.id} className={`req ${q.divergent ? "first" : ""}`} title={`${q.start}${q.end !== undefined ? `–${q.end}` : ""} ms`}>
          <span className="method">{q.method}</span>
          <span className="path">{q.path}</span>
          <Status q={q} />
          {q.sql && q.sql.writes > 0 && (
            <span className="writes" title={`${q.sql.total} statements, ${q.sql.writes} writes${q.sql.errors ? `, ${q.sql.errors} failed` : ""}`}>
              {q.sql.writes}w
            </span>
          )}
          {q.sql && q.sql.errors > 0 && <span className="writes bad">{q.sql.errors} sql err</span>}
          {q.harness?.map((h) => (
            <span key={h} className="harness inline">
              {h}
            </span>
          ))}
        </div>
      ))}
      {cell.error && <div className="cell-error">{cell.error}</div>}
    </>
  );
}

function Status({ q }: { q: Request }) {
  if (q.failure) return <span className="status bad">{q.status !== undefined ? `${q.status} ✗` : "✗"} {q.failure}</span>;
  if (q.status === undefined) return <span className="status muted">no answer</span>;
  const cls = q.status >= 500 ? "bad" : q.status >= 400 ? "warn" : "good";
  return <span className={`status ${cls}`}>{q.status}</span>;
}

function sig(q: Request): string {
  return `${q.method} ${q.path.split("?")[0]} ${q.failure ? "x" : (q.status ?? "?")} ${q.sql?.writes ?? ""}`;
}

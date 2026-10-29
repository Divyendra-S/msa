import { useState } from "react";
import { api, type ChainEventView, type RepView } from "./api.ts";
import { ms, short } from "./util.ts";

/** Per table: the requests whose statements wrote it, through which handler and line, to what result. */
export function TracePanel({ rep }: { rep: RepView }) {
  if (!rep.trace) return <p className="muted">No SQL log for this run (db.sqlLog is off, or the run did not start).</p>;
  const { tables, focus, more } = rep.trace;
  if (tables.length === 0) return <p className="muted">No table changed and no rule broke.</p>;
  return (
    <div className="trace">
      <p className="muted small">
        Request → handler → SQL → result, for {focus.length ? "the tables the broken rules read, then the others the run changed" : "the tables the run changed"}. Reads
        are the writers' own reads of the table (check-then-act shows as read, read, write, write).
      </p>
      {tables.map((t) => (
        <section key={t.table} className={`trace-table ${focus.includes(t.table) ? "focus" : ""}`}>
          <h3>
            <span className="mono">{t.table}</span> <span className="muted">{t.change}</span>
            {focus.includes(t.table) && <span className="pill bad outline">read by a broken rule</span>}
          </h3>
          {t.events.length === 0 ? (
            <p className="muted small">No statement wrote to it.</p>
          ) : (
            <ol className="chain">
              {t.events.map((e, i) => (
                <ChainEvent key={i} e={e} />
              ))}
              {t.more > 0 && <li className="muted small">… {t.more} more statements on this table</li>}
            </ol>
          )}
        </section>
      ))}
      {more.length > 0 && <p className="muted small">Also changed: {more.join(", ")}</p>}
    </div>
  );
}

function ChainEvent({ e }: { e: ChainEventView }) {
  const [open, setOpen] = useState(false);
  if (e.kind === "external") {
    return (
      <li className="ev external">
        <span className="at">{e.at}</span>
        <span className="ext">{e.text}</span>
      </li>
    );
  }
  const sql = e.sql.replace(/\s+/g, " ").trim();
  return (
    <li className={`ev ${e.write ? "write" : "read"} ${e.error ? "bad" : ""}`}>
      <span className="at">{e.at}</span>
      <span className="links">
        {e.sources.length === 0 && <span className="muted">(no request running)</span>}
        {e.sources.map((s, i) => (
          <span key={i} className="src">
            {i > 0 && <span className="muted"> or </span>}
            {s.who.length > 0 && <span className="who">{s.who.join("|")}</span>}
            <span className="mono">{s.what}</span>
            {s.handler && (
              <>
                <span className="arrow">→</span>
                <span className="file">
                  {s.handler}
                  {s.lines.length > 0 && `:${s.lines.join(",")}`}
                </span>
              </>
            )}
          </span>
        ))}
        {e.elsewhere && <span className="muted small"> (SQL at {e.elsewhere})</span>}
      </span>
      <span className="arrow">→</span>
      <button type="button" className={`sql ${open ? "open" : ""}`} onClick={() => setOpen(!open)} title="Show the whole statement">
        {open ? e.sql.trim() : sql.length > 120 ? `${sql.slice(0, 119)}…` : sql}
        {e.params && e.params.length > 0 && <span className="params"> [{e.params.map((p) => (p === null ? "null" : p)).join(", ")}]</span>}
      </button>
      <span className="arrow">→</span>
      <span className={`result ${e.error ? "bad-text" : ""}`}>{e.result}</span>
      <span className="muted small mono">
        c{e.conn}
        {e.tx ? ", tx" : e.write ? ", no tx" : ""} · {e.ms} ms
      </span>
    </li>
  );
}

/** Rows added, removed and changed, against the seed data. */
export function DbPanel({ rep }: { rep: RepView }) {
  if (!rep.diff) return <p className="muted">No database diff for this run.</p>;
  const names = Object.keys(rep.diff.tables);
  if (names.length === 0) return <p className="muted">The run changed nothing in the database.</p>;
  return (
    <div className="db">
      <p className="mono small">{rep.diff.summary}</p>
      {names.map((name) => {
        const d = rep.diff!.tables[name]!;
        if (d.countOnly) {
          return (
            <section key={name}>
              <h3 className="mono">{name}</h3>
              <p className="muted small">
                {d.countOnly.before} → {d.countOnly.after} rows (too large to compare row by row)
              </p>
            </section>
          );
        }
        const cols = [...new Set([...d.added, ...d.removed].flatMap((r) => Object.keys(r)))];
        return (
          <section key={name}>
            <h3 className="mono">
              {name}{" "}
              <span className="muted">
                {[d.added.length && `+${d.added.length}`, d.changed.length && `~${d.changed.length}`, d.removed.length && `-${d.removed.length}`].filter(Boolean).join(" ")}
              </span>
            </h3>
            {(d.added.length > 0 || d.removed.length > 0) && (
              <div className="table-wrap">
                <table className="rows">
                  <thead>
                    <tr>
                      <th />
                      {cols.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.added.map((r, i) => (
                      <tr key={`a${i}`} className="added">
                        <td>+</td>
                        {cols.map((c) => (
                          <td key={c}>{short(r[c], 40)}</td>
                        ))}
                      </tr>
                    ))}
                    {d.removed.map((r, i) => (
                      <tr key={`r${i}`} className="removed">
                        <td>−</td>
                        {cols.map((c) => (
                          <td key={c}>{short(r[c], 40)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.changed.length > 0 && (
              <ul className="changed">
                {d.changed.map((c, i) => (
                  <li key={i}>
                    <span className="mono muted">{Object.entries(c.key).map(([k, v]) => `${k}=${short(v, 30)}`).join(", ")}</span>{" "}
                    {Object.entries(c.changes).map(([k, [a, b]]) => (
                      <span key={k} className="change">
                        <span className="mono">{k}</span> <span className="removed-text">{short(a, 30)}</span> → <span className="added-text">{short(b, 30)}</span>
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function RulesPanel({ rep }: { rep: RepView }) {
  if (rep.rules.length === 0) return <p className="muted">No rules were checked in this run.</p>;
  const sorted = [...rep.rules].sort((a, b) => Number(a.ok) - Number(b.ok));
  return (
    <div className="rules">
      {sorted.map((r) => (
        <section key={r.id} className={`rule ${r.ok ? "ok" : r.error ? "error" : "broken"}`}>
          <h3>
            <span className={`pill ${r.ok ? "good" : r.error ? "error" : "bad"}`}>{r.ok ? "held" : r.error ? "could not run" : "broken"}</span>
            <span className="mono">{r.id}</span>
            {r.description && <span className="muted"> — {r.description}</span>}
          </h3>
          {r.error && <div className="error-line">{r.error}</div>}
          {!r.ok && r.rows.length > 0 && <RowsTable rows={r.rows} />}
          {r.sql && (
            <details>
              <summary className="small">SQL (lists the rows that break the rule)</summary>
              <pre className="code">{r.sql}</pre>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}

function RowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return (
    <div className="table-wrap">
      <table className="rows">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{short(r[c], 40)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RequestsPanel({ rep }: { rep: RepView }) {
  const [all, setAll] = useState(false);
  const list = all ? rep.requests : rep.requests.filter((r) => r.notable);
  return (
    <div className="requests">
      <label className="small toggle">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show page loads and server-component fetches too ({rep.requests.length} in all)
      </label>
      <div className="table-wrap">
        <table className="rows reqs">
          <thead>
            <tr>
              <th>ms</th>
              <th>tab / step</th>
              <th>request</th>
              <th>result</th>
              <th>SQL</th>
              <th>handler</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={r.failure || (r.status ?? 0) >= 500 ? "bad-row" : (r.status ?? 0) >= 400 ? "warn-row" : ""}>
                <td className="mono">
                  {r.start}
                  {r.end !== undefined && `–${r.end}`}
                </td>
                <td>
                  {r.tab}
                  {r.step && <span className="muted"> / {r.step}</span>}
                </td>
                <td className="mono">
                  {r.method} {r.path}
                  {r.harness?.map((h) => (
                    <div key={h} className="harness inline">
                      {h}
                    </div>
                  ))}
                </td>
                <td className="mono">{r.failure ? `${r.status !== undefined ? `${r.status}, then ` : ""}✗ ${r.failure}` : (r.status ?? "no answer")}</td>
                <td className="mono">{r.sql ? `${r.sql.total}${r.sql.writes ? ` · ${r.sql.writes}w` : ""}${r.sql.errors ? ` · ${r.sql.errors} err` : ""}` : ""}</td>
                <td className="mono small">{r.handler ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rep.race && (
        <p className="small">
          Race on <code>{rep.race.request}</code>: held {rep.race.arrived.map((a) => `${a.tab} (#${a.arrival})`).join(", ")}; released {rep.race.released.join(", then ")}
          {rep.race.timedOut && " (timed out waiting for more)"}
        </p>
      )}
      {(rep.charges.length > 0 || rep.webhooks.length > 0) && (
        <div className="small">
          {rep.charges.map((c) => (
            <div key={c.id} className="mono">
              charge {c.id} {c.amount} · order {c.metadata.order_id ?? "?"} · {c.idempotencyKey ? `key ${c.idempotencyKey}` : "no idempotency key"}
            </div>
          ))}
          {rep.webhooks.map((w) => (
            <div key={w.event} className="mono">
              webhook {w.event} {w.type} {w.charge} → {w.deliveries.map((d) => d.status ?? d.error ?? "?").join(", ") || "not delivered"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PagePanel({ rep }: { rep: RepView }) {
  return (
    <div className="page-panel">
      {rep.errors.length === 0 && <p className="muted">The flow finished on every tab: no page to show. Screenshots are kept only where a flow failed.</p>}
      {rep.errors.map((e, i) => (
        <section key={i} className="page-error">
          <h3>
            {e.tab}
            {e.step && <span className="muted"> / {e.step}</span>}
          </h3>
          <div className="error-line">{e.message}</div>
          {e.page && (
            <p className="small">
              On <code>{e.page.path}</code>
              {e.page.alerts.length > 0 && <> · alert: {e.page.alerts.map((a) => `"${a}"`).join(", ")}</>}
              <br />
              <span className="muted">“{e.page.text}”</span>
            </p>
          )}
          {e.locator && (
            <p className="small">
              <code>{e.locator.action}</code> waited for <code>{e.locator.locator}</code>
              {e.locator.matched ? ` and found ${e.locator.matched} elements` : ", not on the page"}
            </p>
          )}
        </section>
      ))}
      {rep.screenshots.length > 0 && (
        <div className="shots">
          {rep.screenshots.map((s) => (
            <figure key={s}>
              <a href={api.screen(rep.run, rep.rep, s)} target="_blank" rel="noreferrer">
                <img src={api.screen(rep.run, rep.rep, s)} alt={`Page of tab ${s.replace(/\.jpg$/, "")} when the flow failed`} loading="lazy" />
              </a>
              <figcaption className="small muted">{s.replace(/\.jpg$/, "")}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {rep.traces.length > 0 && (
        <p className="small">
          Playwright trace:{" "}
          {rep.traces.map((t) => (
            <code key={t} className="block">
              npx playwright show-trace {t}
            </code>
          ))}
        </p>
      )}
    </div>
  );
}

export function LogPanel({ rep }: { rep: RepView }) {
  const errors = rep.console.filter((c) => c.type === "error" || c.type === "warning");
  return (
    <div className="log-panel">
      <h3>Browser console {rep.console.length > 0 && <span className="muted">({rep.console.length})</span>}</h3>
      {rep.console.length === 0 ? (
        <p className="muted small">No console messages.</p>
      ) : (
        <ul className="console">
          {(errors.length ? errors : rep.console).slice(0, 200).map((c, i) => (
            <li key={i} className={c.type}>
              <span className="mono muted">{ms(c.at)}</span> <span className="muted">{c.tab}{c.step ? ` / ${c.step}` : ""}</span> <span className="mono">{c.text}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>App log <span className="muted small">(last {rep.log.length} lines)</span></h3>
      {rep.log.length === 0 ? <p className="muted small">Empty.</p> : <pre className="code log">{rep.log.join("\n")}</pre>}
    </div>
  );
}

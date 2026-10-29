import { useEffect, useMemo, useState } from "react";
import { TerminalIcon } from "./App.tsx";
import { api, type Comparison, type LaneRef, type RepView, type RunDetail, type RunListEntry, type Status } from "./api.ts";
import { DbPanel, LogPanel, PagePanel, RequestsPanel, RulesPanel, TracePanel } from "./Panels.tsx";
import { Timeline } from "./Timeline.tsx";
import { ago, claudeLink, href, ms, plural, tone } from "./util.ts";

const TABS = [
  ["timeline", "Timeline"],
  ["trace", "Trace chain"],
  ["database", "Database"],
  ["rules", "Rules"],
  ["requests", "Requests"],
  ["page", "Page"],
  ["log", "Log"],
] as const;
type Tab = (typeof TABS)[number][0];

export function RunPage({ route, status, version, runs }: { route: { id: string; rep?: number; tab?: string }; status: Status; version: number; runs: RunListEntry[] }) {
  const { id } = route;
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rep, setRep] = useState<RepView | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);

  useEffect(() => {
    api.run(id).then(
      (d) => {
        setDetail(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [id, version]);

  const n = route.rep ?? detail?.focus ?? detail?.reps[0]?.rep;
  const summary = detail?.reps.find((r) => r.rep === n);
  const tab: Tab = TABS.some(([t]) => t === route.tab) ? (route.tab as Tab) : "timeline";

  useEffect(() => {
    if (!n || !summary) return;
    setRep(null);
    api.rep(id, n).then(setRep, (e: Error) => setError(e.message));
  }, [id, n, summary?.outcome, version]);

  // The lanes to line up: this repetition and one that held every rule (or, for a good one, the run's failing one).
  const lanes = useMemo((): LaneRef[] => {
    if (!detail || !n || !summary) return [];
    const other =
      summary.outcome === "ok"
        ? detail.focus && detail.focus !== n
          ? { run: id, rep: detail.focus }
          : undefined
        : detail.reference && !(detail.reference.run === id && detail.reference.rep === n)
          ? { run: detail.reference.run, rep: detail.reference.rep }
          : undefined;
    return [{ run: id, rep: n }, ...(other ? [other] : [])];
  }, [detail, id, n, summary]);

  useEffect(() => {
    if (lanes.length === 0) return;
    setComparison(null);
    api.compare(lanes).then(setComparison, () => setComparison(null));
  }, [JSON.stringify(lanes), version]);

  if (error && !detail) return <div className="empty">{error}</div>;
  if (!detail) return <div className="loading">Loading run…</div>;
  const result = detail.result;
  const outcome = result?.outcome ?? (detail.reps.length < detail.total ? "running" : "stopped");
  const listed = runs.find((r) => r.id === id);
  const headline = listed?.headline ?? outcome;
  const div = comparison?.divergence[0];
  const prompt = `Wind Tunnel run ${id} (${detail.experiment.id}): ${headline}. Read its evidence with the windtunnel_evidence tool, handle "${id}", find the root cause in the code, fix it, then prove the fix with /windtunnel:prove.`;
  const go = (t: Tab, r = n) => href({ page: "run", id, rep: r, tab: t });

  return (
    <div className="run">
      <section className="run-head-card">
        <div className="title-row">
          <span className={`badge ${tone(outcome)}`}>{outcome.toUpperCase()}</span>
          <h1>{detail.experiment.id}</h1>
          <span className="muted mono">{id}</span>
          <a className="btn ghost small push" href={claudeLink(status.project.root, prompt)} title="Opens Claude Code in a new terminal with this prompt typed (not sent)">
            <TerminalIcon /> Fix in Claude Code
          </a>
        </div>
        {detail.experiment.description && <p className="desc">{detail.experiment.description}</p>}
        <div className="facts">
          <span>
            <b>{headline}</b>
          </span>
          {result && (
            <>
              <span>
                version <code>{result.version.id}</code> <span className="muted">{result.version.label}</span>
              </span>
              <span>{ms(result.durationMs)}</span>
              <span className="muted" title={result.startedAt}>
                {ago(result.startedAt)}
              </span>
            </>
          )}
          <span>flow <code>{detail.experiment.flow}</code></span>
          {detail.experiment.perturb?.length > 0 && <span>{plural(detail.experiment.perturb.length, "perturbation")}</span>}
          {detail.experiment.race && (
            <span>
              race on <code>{detail.experiment.race.request}</code>
            </span>
          )}
        </div>
        {detail.triage && (
          <div className={`triage ${detail.triage.label === "bug" ? "bad" : detail.triage.label ? "warn" : "muted"}`}>
            Sorted as <b>{detail.triage.label ? detail.triage.label.replace("-", " ") : "undecided"}</b> — {detail.triage.reason}{" "}
            <span className="muted">[{detail.triage.by}]</span>
            {detail.triage.rerun && (
              <>
                {" "}
                · re-ran: <a href={href({ page: "run", id: detail.triage.rerun.runId })}>{detail.triage.rerun.outcome}</a>
              </>
            )}
          </div>
        )}
        {result && result.variants.length > 1 && (
          <table className="variants">
            <thead>
              <tr>
                <th>variant</th>
                <th>result</th>
                <th>ok</th>
                <th>broken</th>
                <th>error</th>
                <th>flake rate</th>
              </tr>
            </thead>
            <tbody>
              {result.variants.map((v) => (
                <tr key={v.variant}>
                  <td className="mono">{v.variant}</td>
                  <td>
                    <span className={`pill ${tone(v.outcome)}`}>{v.outcome}</span>
                  </td>
                  <td>{v.ok}</td>
                  <td>{v.broken}</td>
                  <td>{v.errors}</td>
                  <td>{Math.round(v.flakeRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {result?.warnings?.map((w) => (
          <div key={w} className="warning">
            Not exercised: {w}
          </div>
        ))}
        <div className="reps" role="list" aria-label="Repetitions">
          {Array.from({ length: detail.total }, (_, i) => {
            const r = detail.reps.find((x) => x.rep === i + 1);
            return r ? (
              <a
                key={i}
                role="listitem"
                className={`rep ${tone(r.outcome)} ${r.rep === n ? "current" : ""}`}
                href={go(tab, r.rep)}
                title={`#${r.rep}${r.variant !== "default" ? ` [${r.variant}]` : ""} ${r.outcome}${r.broken.length ? `: ${r.broken.join(", ")}` : ""}${r.error ? `: ${r.error}` : ""}`}
              >
                {r.rep}
              </a>
            ) : (
              <span key={i} role="listitem" className="rep pending" title="still running">
                {i + 1}
              </span>
            );
          })}
        </div>
      </section>

      {summary && (
        <section className="rep-card">
          <div className="rep-title">
            <h2>
              Run #{n}
              {summary.variant !== "default" && <span className="mono muted"> [{summary.variant}]</span>}
            </h2>
            <span className={`pill ${tone(summary.outcome)}`}>{summary.outcome}</span>
            {summary.broken.map((b) => (
              <a key={b} className="pill bad outline" href={go("rules")}>
                {b}
              </a>
            ))}
            <span className="muted">{ms(summary.durationMs)}</span>
            {summary.diff && <span className="mono muted">{summary.diff}</span>}
          </div>
          {summary.error && <div className="error-line">{summary.error}</div>}
          {div && comparison && (
            <div className="divergence">
              <div className="div-label">First divergence</div>
              <div>
                Compared with {lanes[1]?.run === id ? `run #${lanes[1]?.rep} of this experiment` : detail.reference?.label ?? "the other run"}
                {detail.reference?.experimentChanged && <span className="muted"> (it used a different version of the experiment file)</span>}, tab{" "}
                <b>{div.tab}</b>:
              </div>
              <div className="div-pair">
                <div>
                  <span className="muted">this run</span> <code className="bad-text">{div.ours}</code>
                </div>
                <div>
                  <span className="muted">that run</span> <code className="good-text">{div.theirs}</code>
                </div>
              </div>
            </div>
          )}
          {!div && comparison && comparison.reference > 0 && <div className="muted small">Same requests in the same order as the run that held every rule.</div>}

          <nav className="tabs" aria-label="Run details">
            {TABS.map(([t, label]) => (
              <a key={t} className={t === tab ? "active" : ""} href={go(t)}>
                {label}
                {rep && <TabCount tab={t} rep={rep} />}
              </a>
            ))}
          </nav>
          <div className="tab-body">
            {tab === "timeline" &&
              (comparison ? (
                <Timeline comparison={comparison} lanes={lanes} compareHref={href({ page: "compare", lanes })} />
              ) : (
                <div className="loading">Lining up the runs…</div>
              ))}
            {tab !== "timeline" && !rep && <div className="loading">Loading…</div>}
            {rep && tab === "trace" && <TracePanel rep={rep} />}
            {rep && tab === "database" && <DbPanel rep={rep} />}
            {rep && tab === "rules" && <RulesPanel rep={rep} />}
            {rep && tab === "requests" && <RequestsPanel rep={rep} />}
            {rep && tab === "page" && <PagePanel rep={rep} />}
            {rep && tab === "log" && <LogPanel rep={rep} />}
          </div>
        </section>
      )}
      {!summary && detail.reps.length === 0 && <div className="loading">Waiting for the first repetition to finish…</div>}
    </div>
  );
}

function TabCount({ tab, rep }: { tab: Tab; rep: RepView }) {
  let n: number | undefined;
  let bad = false;
  if (tab === "rules") {
    n = rep.rules.filter((r) => !r.ok).length;
    bad = n > 0;
    if (!n) n = undefined;
  } else if (tab === "requests") n = rep.requests.filter((r) => r.notable).length;
  else if (tab === "database") n = Object.keys(rep.diff?.tables ?? {}).length || undefined;
  else if (tab === "page") {
    n = rep.errors.length || undefined;
    bad = !!n;
  } else if (tab === "trace") n = rep.trace?.tables.filter((t) => t.events.length).length || undefined;
  return n === undefined ? null : <span className={`count ${bad ? "bad" : ""}`}>{n}</span>;
}

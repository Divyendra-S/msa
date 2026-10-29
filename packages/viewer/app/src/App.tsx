import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type RunListEntry, type ServerEvent, type Status, type Usage } from "./api.ts";
import { ComparePage } from "./Compare.tsx";
import { HuntPage } from "./Hunt.tsx";
import { RunPage } from "./Run.tsx";
import { RunsList } from "./RunsList.tsx";
import { UsageMeter } from "./Usage.tsx";
import { claudeLink, href, parseRoute, type Route } from "./util.ts";

function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return useMemo(() => parseRoute(hash), [hash]);
}

/** Server events, for pages that follow a hunt or a run as it goes. */
export type Bus = EventTarget;

export function App() {
  const route = useRoute();
  const [status, setStatus] = useState<Status | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunListEntry[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  /** Bumped per run id when the store says it changed, so open pages reload it. */
  const [versions, setVersions] = useState<Record<string, number>>({});
  const [live, setLive] = useState(false);
  const bus = useRef<Bus>(new EventTarget()).current;

  const guard = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) setLocked(err.message);
    else console.error(err);
  }, []);
  const loadRuns = useCallback(() => api.runs().then(setRuns, guard), [guard]);
  const loadUsage = useCallback(() => api.usage().then(setUsage, guard), [guard]);
  const loadStatus = useCallback(() => api.status().then(setStatus, guard), [guard]);

  useEffect(() => {
    void loadStatus();
    void loadRuns();
    void loadUsage();
  }, [loadStatus, loadRuns, loadUsage]);

  useEffect(() => {
    if (locked) return;
    const source = new EventSource("/api/events");
    source.onopen = () => {
      setLive(true);
      // After a reconnect: catch up on what changed while the stream was down.
      void loadRuns();
      void loadUsage();
    };
    source.onerror = () => setLive(false);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as ServerEvent;
      if (e.type === "runs") {
        void loadRuns();
        setVersions((v) => {
          const next = { ...v };
          for (const id of e.changed) next[id] = (next[id] ?? 0) + 1;
          return next;
        });
      } else if (e.type === "usage") void loadUsage();
      else if (e.type === "hunt") void loadStatus();
      bus.dispatchEvent(new CustomEvent("server", { detail: e }));
    };
    return () => source.close();
  }, [locked, bus, loadRuns, loadUsage, loadStatus]);

  // The front page opens the newest batch's most telling run.
  useEffect(() => {
    if (route.page !== "runs" || !runs?.length) return;
    const newest = runs[0]!;
    const batch = runs.filter((r) => Math.abs(Date.parse(r.startedAt) - Date.parse(newest.startedAt)) < 2_000);
    const pick = batch.find((r) => r.outcome === "fail") ?? batch.find((r) => r.outcome === "flaky") ?? batch.find((r) => r.outcome === "error") ?? newest;
    location.replace(href({ page: "run", id: pick.id }));
  }, [route, runs]);

  if (locked) {
    return (
      <div className="locked">
        <Logo />
        <h1>Open the viewer from its link</h1>
        <p>
          This page needs the link <code>windtunnel view</code> printed in your terminal (it signs this browser in to the local viewer). Run{" "}
          <code>windtunnel view</code> again to get a new one.
        </p>
      </div>
    );
  }

  const selected = route.page === "run" ? route.id : undefined;
  // Typed into Claude Code's prompt box, not sent: the user adds what to hunt in and presses Enter.
  const prompt = "/windtunnel:hunt ";

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">
          <Logo />
          <span>Wind Tunnel</span>
          {status && <span className="project">{status.project.name}</span>}
        </a>
        <span className={`live-dot ${live ? "on" : ""}`} title={live ? "Live: updates as runs finish" : "Not connected"} />
        <div className="top-right">
          {usage && status && <UsageMeter usage={usage} status={status} />}
          <a className={`btn ${route.page === "hunt" ? "active" : ""}`} href={href({ page: "hunt" })}>
            {status?.hunt.running ? <span className="spin" /> : <PlayIcon />}
            {status?.hunt.running ? "Hunt running" : "Run hunt"}
          </a>
          {status && (
            <a className="btn ghost" href={claudeLink(status.project.root, prompt)} title="Opens Claude Code in a new terminal in this app's folder, with the prompt typed but not sent">
              <TerminalIcon /> Open in Claude Code
            </a>
          )}
        </div>
      </header>
      <aside className="side">
        <RunsList runs={runs} selected={selected} />
      </aside>
      <main className="main">
        {route.page === "run" && status && <RunPage key={route.id} route={route} status={status} version={versions[route.id] ?? 0} runs={runs ?? []} />}
        {route.page === "compare" && <ComparePage lanes={route.lanes} runs={runs ?? []} versions={versions} />}
        {route.page === "hunt" && status && <HuntPage id={route.id} status={status} bus={bus} onChange={loadStatus} />}
        {route.page === "runs" && runs?.length === 0 && <Empty status={status} />}
      </main>
    </div>
  );
}

function Empty({ status }: { status: Status | null }) {
  return (
    <div className="empty">
      <h1>No runs yet</h1>
      <p>
        Runs show up here as soon as they start: from your agent (<code>windtunnel_run</code>), from <code>windtunnel run</code>, or from a hunt
        started with <strong>Run hunt</strong>.
      </p>
      {status && (
        <p className="muted">
          Project: <code>{status.project.root}</code>
        </p>
      )}
    </div>
  );
}

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M4 10h17a4 4 0 1 0-4-4M4 16h22a4 4 0 1 1-4 4M4 22h11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.5 4l4 4-4 4M8 12.5h5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

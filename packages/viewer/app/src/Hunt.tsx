import { useEffect, useRef, useState } from "react";
import type { Bus } from "./App.tsx";
import { api, type HuntEvent, type HuntInfo, type ServerEvent, type Status } from "./api.ts";
import { ago, href, kilo, ms, tone, usd } from "./util.ts";

/** Starts a headless Muse Code hunt and follows its event stream. */
export function HuntPage({ id, status, bus, onChange }: { id?: string; status: Status; bus: Bus; onChange: () => void }) {
  const [hunts, setHunts] = useState<HuntInfo[]>([]);
  const [focus, setFocus] = useState("checkout");
  const [prompt, setPrompt] = useState("");
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = status.hunt.running;
  const shown = id ?? running?.id ?? hunts[0]?.id;

  useEffect(() => {
    if (!edited) setPrompt(defaultPrompt(status.hunt.skill, focus));
  }, [focus, edited, status.hunt.skill]);

  const loadList = () => api.hunts().then(setHunts, () => undefined);
  useEffect(() => {
    void loadList();
    const on = (e: Event) => {
      const event = (e as CustomEvent<ServerEvent>).detail;
      if (event.type === "hunt") void loadList();
    };
    bus.addEventListener("server", on);
    return () => bus.removeEventListener("server", on);
  }, [bus]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const info = await api.startHunt(prompt);
      onChange();
      location.hash = href({ page: "hunt", id: info.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const command = [...status.hunt.command, JSON.stringify(prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt)].join(" ");

  return (
    <div className="hunt">
      <section className="hunt-form">
        <h1>Run a hunt</h1>
        <p className="muted">
          Starts Muse Code headless in <code>{status.project.root}</code>: it maps the app, writes experiments, runs them and proves fixes with Wind Tunnel's tools. Its
          progress streams in below and its runs appear on the left as they start.
        </p>
        <label>
          What to hunt in
          <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="checkout, orders, the cart…" />
        </label>
        <label>
          Prompt
          <textarea
            value={prompt}
            rows={4}
            onChange={(e) => {
              setPrompt(e.target.value);
              setEdited(true);
            }}
          />
        </label>
        <div className="hunt-actions">
          <button type="button" className="btn primary" disabled={!status.hunt.ok || !!running || busy || !prompt.trim()} onClick={() => void start()}>
            {running ? "A hunt is running" : busy ? "Starting…" : "Run hunt"}
          </button>
          {edited && (
            <button type="button" className="btn ghost small" onClick={() => setEdited(false)}>
              Reset prompt
            </button>
          )}
        </div>
        {!status.hunt.ok && <div className="warning">{status.hunt.reason}</div>}
        {error && <div className="error-line">{error}</div>}
        <p className="small muted">
          Runs <code>{command}</code>. Billed to the Meta API key (<code>MODEL_API_KEY</code>) in the shell that started <code>windtunnel view</code>; Claude and Codex
          logins are never used here. To work in Claude Code instead, use <b>Open in Claude Code</b>.
        </p>
      </section>

      {shown && <HuntLog key={shown} id={shown} bus={bus} />}

      {hunts.length > 0 && (
        <section className="hunt-list">
          <h2>Earlier hunts</h2>
          <ul>
            {hunts.map((h) => (
              <li key={h.id}>
                <a href={href({ page: "hunt", id: h.id })} className={h.id === shown ? "selected" : ""}>
                  <span className={`dot ${tone(h.status === "running" ? "running" : h.status)}`} />
                  <span className="mono">{h.id}</span>
                  <span className="muted">{ago(h.startedAt)}</span>
                  <span className="ellipsis">{h.prompt}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function defaultPrompt(skill: string, focus: string): string {
  const where = focus.trim() || "the app";
  return `Use the ${skill} skill to hunt for bugs in ${where}. For each bug you confirm, give the run id that shows it and prove the fix.`;
}

function HuntLog({ id, bus }: { id: string; bus: Bus }) {
  const [info, setInfo] = useState<HuntInfo | null>(null);
  const [events, setEvents] = useState<HuntEvent[]>([]);
  const [raw, setRaw] = useState(false);
  const [now, setNow] = useState(Date.now());
  const end = useRef<HTMLLIElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    api.hunt(id).then((h) => {
      setInfo(h.info);
      setEvents(h.events);
    }, () => undefined);
    const on = (e: Event) => {
      const event = (e as CustomEvent<ServerEvent>).detail;
      if (event.type === "hunt-event" && event.id === id) setEvents((list) => (list.some((x) => x.seq === event.event.seq) ? list : [...list, event.event]));
      if (event.type === "hunt" && event.id === id) setInfo(event.info);
    };
    bus.addEventListener("server", on);
    return () => bus.removeEventListener("server", on);
  }, [id, bus]);

  useEffect(() => {
    if (info?.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [info?.status]);

  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: "nearest" });
  }, [events.length]);

  if (!info) return <div className="loading">Loading hunt…</div>;
  const elapsed = (info.endedAt ? Date.parse(info.endedAt) : now) - Date.parse(info.startedAt);
  const usage = info.usage;
  return (
    <section className="hunt-log">
      <div className="title-row">
        <span className={`badge ${tone(info.status === "running" ? "running" : info.status)}`}>{info.status.toUpperCase()}</span>
        <h2 className="mono">{info.id}</h2>
        <span className="muted">{ms(elapsed)}</span>
        {(usage.input > 0 || usage.output > 0) && (
          <span className="muted" title="As reported in the agent's events">
            {kilo(usage.input)} in · {kilo(usage.output)} out{usage.cached ? ` · ${kilo(usage.cached)} cached` : ""}
            {usage.usd ? ` · ${usd(usage.usd)}` : ""}
          </span>
        )}
        <label className="small push toggle">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw events
        </label>
        {info.status === "running" && (
          <button type="button" className="btn small" onClick={() => void api.stopHunt(id)}>
            Stop
          </button>
        )}
      </div>
      <p className="small prompt-echo">{info.prompt}</p>
      <ol
        className="events"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {events.length === 0 && <li className="muted">Waiting for the first event…</li>}
        {events.map((e) => (
          <li key={e.seq} className={`ev-${e.kind}`}>
            <span className="at mono">{ms(e.at)}</span>
            {e.kind === "tool" ? (
              <span>
                <span className="tool">{e.tool}</span> {e.text && <span className="mono muted small">{e.text}</span>}
              </span>
            ) : (
              <span className={e.kind === "stderr" ? "muted mono small" : e.kind === "message" ? "" : "mono small"}>{e.text ?? e.type ?? e.kind}</span>
            )}
            {raw && e.raw && <pre className="code small">{e.raw}</pre>}
          </li>
        ))}
        <li ref={end} className="sentinel" aria-hidden="true" />
      </ol>
    </section>
  );
}

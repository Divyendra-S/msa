import type { RunListEntry } from "./api.ts";

export type Route =
  | { page: "runs" }
  | { page: "run"; id: string; rep?: number; tab?: string }
  | { page: "compare"; lanes: { run: string; rep: number }[] }
  | { page: "hunt"; id?: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "run" && parts[1]) {
    const rep = Number(parts[2]);
    return { page: "run", id: parts[1], ...(Number.isInteger(rep) && rep > 0 ? { rep } : {}), ...(parts[3] ? { tab: parts[3] } : {}) };
  }
  if (parts[0] === "compare" && parts[1]) {
    const lanes = parts[1]
      .split(",")
      .map((l) => /^([\w-]+)~(\d+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ run: m[1]!, rep: Number(m[2]) }));
    return { page: "compare", lanes };
  }
  if (parts[0] === "hunt") return { page: "hunt", ...(parts[1] ? { id: parts[1] } : {}) };
  return { page: "runs" };
}

export function href(route: Route): string {
  switch (route.page) {
    case "run":
      return `#/run/${route.id}${route.rep ? `/${route.rep}${route.tab ? `/${route.tab}` : ""}` : ""}`;
    case "compare":
      return `#/compare/${route.lanes.map((l) => `${l.run}~${l.rep}`).join(",")}`;
    case "hunt":
      return `#/hunt${route.id ? `/${route.id}` : ""}`;
    default:
      return "#/";
  }
}

/** pass/ok → good, fail/broken → bad, flaky → warn, error/stopped → error, running → live. */
export function tone(outcome: string | undefined): string {
  switch (outcome) {
    case "pass":
    case "ok":
    case "done":
      return "good";
    case "fail":
    case "broken":
    case "failed":
      return "bad";
    case "flaky":
      return "warn";
    case "running":
      return "live";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

export function ms(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "–";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`;
}

export function kilo(n: number): string {
  const one = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  return n >= 1_000_000 ? `${one(n / 1_000_000)}M` : n >= 1000 ? `${one(n / 1000)}k` : String(n);
}

export function usd(n: number): string {
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function clock(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function day(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? "today" : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** Runs started together (one `windtunnel run`): starts within two seconds of each other (list order: newest first). */
export interface Batch {
  key: string;
  startedAt: string;
  runs: RunListEntry[];
}

export function batches(runs: RunListEntry[]): Batch[] {
  const out: Batch[] = [];
  for (const r of runs) {
    const last = out.at(-1);
    if (last && Math.abs(Date.parse(last.startedAt) - Date.parse(r.startedAt)) < 2_000) last.runs.push(r);
    else out.push({ key: r.id, startedAt: r.startedAt, runs: [r] });
  }
  return out;
}

/**
 * A `claude-cli://` deep link: opens Claude Code in a new terminal in `cwd` with the prompt
 * typed but not sent. Nothing runs until the user presses Enter, on their own login.
 */
export function claudeLink(cwd: string, prompt: string): string {
  const q = prompt.length > 5_000 ? `${prompt.slice(0, 4_990)}…` : prompt;
  return `claude-cli://open?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(q)}`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

export function short(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s === undefined) return "undefined";
  const ts = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d(?:\.\d{1,3})?)/.exec(s);
  if (ts) return `${ts[1]} ${ts[2]}`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

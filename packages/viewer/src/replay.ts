import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRuns, matchesRequest, parseRequestPattern, type RequestRecord, type RuleResult, type Runner, type StepRecord } from "@windtunnel/core";
import type { Workspace } from "@windtunnel/mcp";
import { type MapExperiment, mapView } from "./map.ts";

/*
 * How the agent tested, for the Mac app's Replay: every experiment in the order it was first run,
 * and its newest run as the browser lived it. One lane per tab, one column per step of the flow,
 * the page as it looked when the step ended, the requests the step sent and what the harness did
 * to them, then what the database said.
 */

export interface ReplayView {
  experiments: ReplayExperiment[];
  /** Runs on record, and when the oldest started. */
  runs: number;
  since?: string;
}

export interface ReplayExperiment {
  id: string;
  description?: string;
  users: string[];
  pressure: MapExperiment["pressure"];
  /** Its runs on record, oldest first (the last 16). */
  history: { id: string; outcome: string; startedAt: string }[];
  /** The newest finished run, and the repetition shown (a broken one if any). */
  run?: { id: string; outcome: string; startedAt: string; rep: number; reps: number; broken: string[]; durationMs: number; error?: string };
  lanes: { tab: string; user: string }[];
  /** A column per step of the flow; `pressure`: what the experiment did there, in a few words. */
  columns: { step: string; attempt?: string; start: number; pressure: string[] }[];
  frames: ReplayFrame[];
  /** The payment provider's webhook deliveries, under the step they came during. */
  webhooks: { column: number; at: number; type: string; status: number | null; ms?: number }[];
  /** Rules that broke in the repetition shown, and how many held. */
  rules: { broken: { id: string; description?: string; rows: number; sample?: string }[]; held: number };
  /** What changed in the database, e.g. `orders +2`. */
  changes: string[];
}

export interface ReplayFrame {
  lane: number;
  column: number;
  step: string;
  attempt?: string;
  /** ms since the run started. */
  start: number;
  end: number;
  /** The user the tab was logged in as, when the flow switched. */
  as?: string;
  /** Where the tab was when the step ended, and the start of what it said. */
  path?: string;
  text?: string;
  /** The screenshot, as an API path. */
  shot?: string;
  actions: string[];
  /** What the harness did around the step, in full and in a few words. */
  harness: string[];
  tags: string[];
  error?: string;
  requests: ReplayRequest[];
}

export interface ReplayRequest {
  method: string;
  path: string;
  count: number;
  statuses: (number | null)[];
  /** Sent while the same request from another tab was still in the app. */
  together: boolean;
  /** What the harness did to them, in a few words; `notes` in full. */
  tags: string[];
  notes: string[];
  /** Sent by another session for this tab (a replay as another user). */
  from?: string;
}

const HISTORY = 16;
const TEXT = 280;

export async function replayView(workspace: Workspace, runner: Runner): Promise<ReplayView> {
  const [map, rules, runs] = await Promise.all([mapView(workspace, runner), workspace.rules(), listRuns(runner.store, 300)]);
  const describe = new Map(rules.map((r) => [r.id, r.description]));
  const finished = runs.filter((r) => r.outcome !== "running" && r.outcome !== "stopped");
  const history = new Map<string, ReplayExperiment["history"]>();
  for (const r of [...finished].reverse()) {
    const list = history.get(r.experiment) ?? [];
    list.push({ id: r.id, outcome: r.outcome, startedAt: r.startedAt });
    history.set(r.experiment, list);
  }

  const experiments: ReplayExperiment[] = [];
  for (const e of map.experiments) {
    const base = { id: e.id, ...(e.description ? { description: e.description } : {}), users: e.users, pressure: e.pressure, history: (history.get(e.id) ?? []).slice(-HISTORY) };
    const empty = { lanes: [], columns: [], frames: [], webhooks: [], rules: { broken: [], held: 0 }, changes: [] };
    if (!e.run) {
      experiments.push({ ...base, ...empty });
      continue;
    }
    const repDir = runner.store.repDir(join(runner.store.dir, e.run.id), e.run.rep);
    const detail = await readJson<{
      steps: StepRecord[];
      rules: RuleResult[];
      diff?: string;
      durationMs?: number;
      error?: string;
      startedAt?: string;
      webhooks?: { type: string; deliveries: { at: string; status: number | null; ms?: number }[] }[];
    }>(join(repDir, "result.json"));
    const requests = (await readJson<RequestRecord[]>(join(repDir, "requests.json"))) ?? [];
    const run = {
      id: e.run.id,
      outcome: e.run.outcome,
      startedAt: e.run.startedAt,
      rep: e.run.rep,
      reps: e.run.reps,
      broken: e.run.broken,
      durationMs: detail?.durationMs ?? 0,
      ...(detail?.error ? { error: detail.error } : {}),
    };
    if (!detail) {
      experiments.push({ ...base, run, ...empty });
      continue;
    }
    const shot = (file: string) => `/api/runs/${e.run!.id}/reps/${e.run!.rep}/screens/${file}`;
    const board = lay(detail.steps, requests, shot);
    const t0 = Date.parse(detail.startedAt ?? "");
    const webhooks = Number.isNaN(t0)
      ? []
      : (detail.webhooks ?? []).flatMap((w) =>
          w.deliveries.map((d) => {
            const at = Date.parse(d.at) - t0;
            return { column: columnAt(board.columns, at), at, type: w.type, status: d.status, ...(d.ms !== undefined ? { ms: d.ms } : {}) };
          }),
        );
    place(e.pressure, board, webhooks);
    experiments.push({
      ...base,
      run,
      ...board,
      webhooks,
      rules: {
        broken: detail.rules
          .filter((r) => !r.ok)
          .map((r) => ({ id: r.id, ...(describe.get(r.id) ? { description: describe.get(r.id) } : {}), rows: r.rows.length, ...(r.rows[0] ? { sample: sample(r.rows[0]) } : {}) })),
        held: detail.rules.filter((r) => r.ok).length,
      },
      changes: detail.diff && detail.diff !== "no changes" ? detail.diff.split(" · ") : [],
    });
  }

  // In the order the agent first ran them; the ones never run last.
  const first = (e: ReplayExperiment) => e.history[0]?.startedAt ?? "~";
  experiments.sort((a, b) => first(a).localeCompare(first(b)) || a.id.localeCompare(b.id));
  return { experiments, runs: finished.length, ...(finished.length ? { since: finished.at(-1)!.startedAt } : {}) };
}

/**
 * The steps on a grid: a lane per tab in the order they started, a column per step of the flow
 * (the same step in two tabs shares one, so what ran at once lines up), and each step's requests
 * under it.
 */
function lay(steps: StepRecord[], requests: RequestRecord[], shot: (file: string) => string) {
  const sorted = [...steps].sort((a, b) => a.start - b.start);
  const lanes: ReplayExperiment["lanes"] = [];
  const columns: ReplayExperiment["columns"] = [];
  const columnOf = new Map<string, number>();
  const seen = new Map<string, number>();
  const frames: ReplayFrame[] = [];
  for (const s of sorted) {
    if (!lanes.some((l) => l.tab === s.tab)) lanes.push({ tab: s.tab, user: s.tab.replace(/#\d+$/, "") });
    // The nth time this tab ran the step goes in the step's nth column.
    const name = `${s.step}\u0000${s.attempt ?? ""}`;
    const nth = seen.get(`${s.tab}\u0000${name}`) ?? 0;
    seen.set(`${s.tab}\u0000${name}`, nth + 1);
    const key = `${name}\u0000${nth}`;
    let column = columnOf.get(key);
    if (column === undefined) {
      column = columns.length;
      columns.push({ step: s.step, ...(s.attempt ? { attempt: s.attempt } : {}), start: s.start, pressure: [] });
      columnOf.set(key, column);
    }
    frames.push({
      lane: lanes.findIndex((l) => l.tab === s.tab),
      column,
      step: s.step,
      ...(s.attempt ? { attempt: s.attempt } : {}),
      start: s.start,
      end: s.end,
      ...(s.as ? { as: s.as } : {}),
      ...(s.seen ? { path: s.seen.path, text: s.seen.text.length > TEXT ? `${s.seen.text.slice(0, TEXT - 1)}…` : s.seen.text } : {}),
      ...(s.shot ? { shot: shot(s.shot) } : {}),
      actions: s.actions.map((a) => action(a.action)),
      harness: s.harness ?? [],
      tags: unique((s.harness ?? []).map(tag)),
      ...(s.error ? { error: s.error } : {}),
      requests: [],
    });
  }

  // Each request under the step its tab was in when it was sent; a replay's under the step it copied.
  const notable = requests.filter(interesting).sort((a, b) => a.start - b.start);
  const groups = new Map<ReplayFrame, Map<string, RequestRecord[]>>();
  for (const r of notable) {
    const own = frames.filter((f) => lanes[f.lane]!.tab === r.tab);
    const frame = own.length
      ? (own.find((f) => r.start >= f.start && r.start <= f.end) ?? own.findLast((f) => f.start <= r.start) ?? own[0]!)
      : frames.find((f) => f.step === r.step && r.start >= f.start && r.start <= f.end) ?? frames.find((f) => f.step === r.step);
    if (!frame) continue;
    const key = `${r.method} ${pathOf(r.url)}${own.length ? "" : `\u0000${r.tab}`}`;
    const byKey = groups.get(frame) ?? new Map<string, RequestRecord[]>();
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
    groups.set(frame, byKey);
  }
  for (const [frame, byKey] of groups) {
    for (const [key, list] of byKey) {
      const [request, from] = key.split("\u0000");
      const [method, path] = [request!.slice(0, request!.indexOf(" ")), request!.slice(request!.indexOf(" ") + 1)];
      const notes = unique(list.flatMap((r) => r.harness ?? []));
      frame.requests.push({
        method,
        path,
        count: list.length,
        statuses: list.map((r) => (r.failure ? null : (r.status ?? null))),
        together: list.some((r) => notable.some((o) => o.tab !== r.tab && o.method === r.method && pathOf(o.url) === pathOf(r.url) && overlaps(r, o))),
        tags: unique(notes.map(tag)),
        notes,
        ...(from ? { from } : {}),
      });
    }
  }
  return { lanes, columns, frames };
}

/**
 * Puts each of the experiment's pressures on the columns it landed on: its step (and that step
 * again, when it made the user repeat it), else where the requests it caught were touched, and
 * webhook pressure where the deliveries came.
 */
function place(pressure: MapExperiment["pressure"], board: ReturnType<typeof lay>, webhooks: { column: number }[]): void {
  const touched = (c: number) => board.frames.filter((f) => f.column === c).flatMap((f) => f.requests.filter((r) => r.tags.length || r.together));
  for (const p of pressure) {
    let at: number[] = [];
    if (p.what.startsWith("webhook")) at = webhooks.slice(0, 1).map((w) => w.column);
    else if (p.step) at = board.columns.flatMap((c, i) => (c.step === p.step ? [i] : []));
    else {
      const patterns = p.routes.flatMap((key) => {
        try {
          return [parseRequestPattern(key)];
        } catch {
          return [];
        }
      });
      const hit = (c: number) => touched(c).some((r) => patterns.some((q) => matchesRequest(q, r.method, `http://x${r.path}`)));
      at = board.columns.flatMap((_, i) => (hit(i) ? [i] : []));
      if (!at.length) at = board.columns.flatMap((_, i) => (touched(i).length ? [i] : [])).slice(0, 1);
    }
    for (const i of at) if (!board.columns[i]!.pressure.includes(p.what)) board.columns[i]!.pressure.push(p.what);
  }
}

/** The column whose step was going at `at`: the last one started by then. */
function columnAt(columns: { start: number }[], at: number): number {
  let found = 0;
  columns.forEach((c, i) => {
    if (c.start <= at) found = i;
  });
  return found;
}

/** Requests worth showing: anything that writes, fetches, failed or was touched; not page loads that went fine. */
function interesting(r: RequestRecord): boolean {
  if (r.harness?.length) return true;
  if (r.failure && !(r.failure === "net::ERR_ABORTED" && /[?&]_rsc=/.test(r.url))) return true;
  if ((r.status ?? 0) >= 400) return true;
  return r.method !== "GET" || (r.type !== "document" && !/[?&]_rsc=/.test(r.url));
}

/** A Playwright action as a person would say it: `click "Pay"`, `click "Add to cart" on Mug`, `fill Email`, `open /cart`. */
export function action(text: string): string {
  const names = [...text.matchAll(/name: '([^']+)'/g)].map((m) => m[1]!);
  const verb = text.split(" ")[0]!;
  if (verb === "goto") return `open ${/"([^"]+)"/.exec(text)?.[1] ?? text.slice(5)}`;
  if (names.length) return `${verb} "${names.at(-1)}"${names.length > 1 ? ` on ${names[0]}` : ""}`;
  const label = /getBy(?:Label|Placeholder|Text|TestId)\('([^']+)'\)/.exec(text)?.[1];
  if (label) return `${verb} ${label}`;
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** A harness note cut to its gist: `held at the race barrier (arrival 2)` → `held at the race barrier`. */
function tag(note: string): string {
  const copy = /^request \d+ from \S+, sent again with (\S+)'s session/.exec(note);
  if (copy) return `sent again as ${copy[1]}`;
  const gist = note.split(/ \(|: |; /)[0]!.replace(/ by the harness$/, "");
  return gist === "held at the race barrier" ? "held for the race" : gist === "released with the others" ? "released together" : gist;
}

function sample(row: Record<string, unknown>): string {
  return Object.entries(row)
    .slice(0, 4)
    .map(([k, v]) => `${k} ${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(" · ");
}

function pathOf(url: string): string {
  return url.split("?")[0]!;
}

function overlaps(a: RequestRecord, b: RequestRecord): boolean {
  return a.start < (b.end ?? Infinity) && b.start < (a.end ?? Infinity);
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

async function readJson<T>(path: string): Promise<T | undefined> {
  return JSON.parse(await readFile(path, "utf8").catch(() => "null")) ?? undefined;
}

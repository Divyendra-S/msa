import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type RuleResult, ruleSource } from "../rules.ts";
import type { DbDiff } from "./db-diff.ts";
import {
  type EvidenceOptions,
  experimentChanged,
  firstDifference,
  pageDifference,
  interesting,
  type LoadedRep,
  loadRep,
  pickRep,
  type RepDetail,
  referenceFor,
  requestLine,
  ruleTables,
  tablesOf,
  traceContext,
} from "./evidence.ts";
import type { Experiment } from "./experiment.ts";
import type { RequestRecord } from "./network.ts";
import type { ExperimentResult, RepSummary } from "./runner.ts";
import type { RunIndexEntry, RunStore } from "./store.ts";
import { sqlCounts, type StatementParts, statementParts, type TableChain, traceChain, writeTarget } from "./trace.ts";

/*
 * Structured views of the run store for the viewer: the same reading as the evidence
 * packets (evidence.ts), as data instead of text.
 */

/** A run with no activity for this long and no result was stopped before it finished. */
const STALE_MS = 10 * 60_000;

export interface RunListEntry extends RunIndexEntry {
  /** Set while the run is going: repetitions finished and started. */
  running?: { done: number; total: number };
}

/** Finished runs from the index, newest first, with unfinished ones (still running, or stopped) on top. */
export async function listRuns(store: RunStore, limit = 100): Promise<RunListEntry[]> {
  const finished = await store.list(limit);
  const known = new Set(finished.map((e) => e.id));
  const ids = (await readdir(store.dir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && !known.has(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, 20);
  const open: RunListEntry[] = [];
  for (const id of ids) {
    const progress = await runProgress(store, id);
    if (progress) open.push(progress);
  }
  return [...open, ...finished].slice(0, limit);
}

/** A run without a result yet: how far it got, or `stopped` when nothing happened in it for a while. */
async function runProgress(store: RunStore, id: string): Promise<RunListEntry | undefined> {
  const dir = join(store.dir, id);
  if (await exists(join(dir, "run.json"))) return undefined;
  const experiment = await readJson<Experiment>(join(dir, "experiment.json"));
  if (!experiment) return undefined;
  const started = await stat(join(dir, "experiment.json")).catch(() => undefined);
  // Pruned while we looked.
  if (!started) return undefined;
  const reps = await readdir(join(dir, "reps")).catch(() => [] as string[]);
  let done = 0;
  let last = started.mtimeMs;
  for (const rep of reps) {
    const s = await stat(join(dir, "reps", rep, "result.json")).catch(() => undefined);
    if (s) done++;
    last = Math.max(last, s?.mtimeMs ?? (await stat(join(dir, "reps", rep)).catch(() => undefined))?.mtimeMs ?? 0);
  }
  const startedAt = started.mtime.toISOString();
  const stale = Date.now() - last > STALE_MS;
  return {
    id,
    experiment: experiment.id,
    version: "",
    startedAt,
    outcome: stale ? "stopped" : "running",
    headline: stale ? `stopped after ${done}/${reps.length} runs` : `running ${done}/${reps.length}`,
    ...(stale ? {} : { running: { done, total: reps.length } }),
  };
}

export interface TriageNote {
  label?: string;
  reason: string;
  by: string;
  decision?: string;
  rerun?: { runId: string; outcome: string };
}

export interface RunDetail {
  id: string;
  experiment: Experiment;
  /** Absent until the run finishes. */
  result?: ExperimentResult;
  /** Repetitions finished so far. */
  reps: RepSummary[];
  /** Repetitions started. */
  total: number;
  /** The repetition to show first: the first that broke a rule, else the first error. */
  focus?: number;
  /** A run of the same experiment that held every rule, to compare with. */
  reference?: { run: string; rep: number; label: string; experimentChanged: boolean };
  triage?: TriageNote;
}

export async function runDetail(store: RunStore, id: string): Promise<RunDetail> {
  const dir = runDir(store, id);
  const experiment = await readJson<Experiment>(join(dir, "experiment.json"));
  if (!experiment) throw new Error(`no run ${id}`);
  const result = await readJson<ExperimentResult>(join(dir, "run.json"));
  const triage = await readJson<TriageNote>(join(dir, "triage.json"));
  if (!result) {
    const names = await readdir(join(dir, "reps")).catch(() => [] as string[]);
    const reps: RepSummary[] = [];
    for (const n of names.sort((a, b) => Number(a) - Number(b))) {
      const r = await readJson<RepDetail>(join(dir, "reps", n, "result.json"));
      if (r) reps.push(summaryOf(r));
    }
    return { id, experiment, reps, total: names.length, ...(triage ? { triage } : {}) };
  }
  const focus = pickRep(result);
  const reference = focus.outcome === "ok" ? undefined : await referenceFor(store, result, focus);
  return {
    id,
    experiment,
    result,
    reps: result.reps,
    total: result.reps.length,
    focus: focus.rep,
    ...(reference
      ? {
          reference: {
            run: reference.runId,
            rep: reference.rep.rep,
            label: reference.label,
            experimentChanged: reference.runId !== id && (await experimentChanged(store, id, reference.runId)),
          },
        }
      : {}),
    ...(triage ? { triage } : {}),
  };
}

export interface RequestView extends RequestRecord {
  /** Path without the React Server Component marker. */
  path: string;
  /** False for noise: page loads and server-component fetches that went fine. */
  notable: boolean;
  handler?: string;
  sql?: { total: number; writes: number; errors: number };
}

export type ChainEventView = { at: number } & (
  | ({ kind: "sql"; sql: string; params?: (string | null)[]; result: string; error?: string; conn: number; tx: boolean; ms: number } & StatementParts)
  | { kind: "external"; text: string }
);

export interface TableTraceView extends Omit<TableChain, "events"> {
  events: ChainEventView[];
}

export interface RepView {
  run: string;
  experiment: string;
  rep: number;
  variant: string;
  outcome: RepSummary["outcome"];
  error?: string;
  durationMs: number;
  startedAt?: string;
  diffSummary: string;
  warnings?: string[];
  steps: RepDetail["steps"];
  requests: RequestView[];
  rules: (RuleResult & { description?: string; sql?: string })[];
  errors: RepDetail["errors"];
  diff?: DbDiff;
  /** The tables a broken rule reads first (`focus`), then the others the run changed. Absent without a SQL log. */
  trace?: { focus: string[]; tables: TableTraceView[]; more: string[] };
  race?: RepDetail["race"];
  webhooks: RepDetail["webhooks"];
  charges: RepDetail["charges"];
  console: RepDetail["console"];
  /** Screenshots taken when the flow failed, by tab (`screens/<tab>.jpg`); each step's are on the step. */
  screenshots: string[];
  /** Playwright traces kept for this run. */
  traces: string[];
  /** The end of the app's log. */
  log: string[];
}

export async function repView(store: RunStore, id: string, n: number, options: EvidenceOptions = {}): Promise<RepView> {
  const dir = runDir(store, id);
  const experiment = await readJson<Experiment>(join(dir, "experiment.json"));
  if (!experiment) throw new Error(`no run ${id}`);
  const run = (await readJson<ExperimentResult>(join(dir, "run.json"))) ?? partialResult(id, experiment);
  if (!(await exists(join(store.repDir(dir, n), "result.json")))) throw new Error(`run ${id} has no finished repetition ${n}`);
  const rep = await loadRep(store, id, n);
  const ctx = await traceContext(run, rep, options);
  const counts = rep.sql ? sqlCounts(rep.sql) : undefined;
  const rules = new Map((options.rules ?? []).map((r) => [r.id, r]));
  const requests = rep.requests.map((r): RequestView => {
    const path = cleanPath(r.url);
    const handler = options.handlerFor?.(r.method, path.split("?")[0]!);
    const sql = counts?.get(r.id);
    return { ...r, path, notable: interesting(r), ...(handler ? { handler } : {}), ...(sql ? { sql } : {}) };
  });

  let trace: RepView["trace"];
  if (rep.sql) {
    const broken = tablesOf(rep.detail.rules.filter((r) => !r.ok).map((r) => rules.get(r.id)?.sql ?? ""));
    const focus = broken.length ? broken : ruleTables(rep, options);
    const chain = traceChain(rep.sql, rep.diff, focus, ctx, { perTable: 40, tables: 12 });
    trace = {
      focus,
      tables: chain.tables.map((t) => ({
        ...t,
        events: t.events.map((e): ChainEventView =>
          "statement" in e
            ? {
                at: e.at,
                kind: "sql",
                sql: e.statement.sql,
                ...(e.statement.params ? { params: e.statement.params } : {}),
                result: e.statement.error ? `ERROR ${e.statement.error}` : (e.statement.tag ?? "no result"),
                ...(e.statement.error ? { error: e.statement.error } : {}),
                conn: e.statement.conn,
                tx: !!e.statement.tx,
                ms: e.statement.ms,
                ...statementParts(e.statement, ctx),
              }
            : { at: e.at, kind: "external", text: e.external },
        ),
      })),
      more: chain.more,
    };
  }

  const screens = await readdir(join(store.repDir(dir, n), "screens")).catch(() => [] as string[]);
  const log = await readFile(join(store.repDir(dir, n), "app.log"), "utf8").catch(() => "");
  const d = rep.detail;
  return {
    run: id,
    experiment: experiment.id,
    rep: n,
    variant: d.variant,
    outcome: d.outcome,
    ...(d.error ? { error: d.error } : {}),
    durationMs: d.durationMs,
    ...(d.startedAt ? { startedAt: d.startedAt } : {}),
    diffSummary: d.diff,
    ...(d.warnings?.length ? { warnings: d.warnings } : {}),
    steps: d.steps,
    requests,
    rules: d.rules.map((r) => ({ ...r, ...(rules.get(r.id)?.description ? { description: rules.get(r.id)!.description } : {}), ...(rules.get(r.id) ? { sql: ruleSource(rules.get(r.id)!).trim() } : {}) })),
    errors: d.errors,
    ...(rep.diff ? { diff: rep.diff } : {}),
    ...(trace ? { trace } : {}),
    ...(d.race ? { race: d.race } : {}),
    webhooks: d.webhooks,
    charges: d.charges,
    console: d.console,
    screenshots: screens.filter((f) => f.endsWith(".jpg") && !f.startsWith("step-")).sort(),
    traces: d.traces,
    log: log.trimEnd().split("\n").slice(-150).filter(Boolean),
  };
}

/** One run in a comparison: `<run id>/<repetition>`. */
export interface LaneRef {
  run: string;
  rep: number;
}

export interface LaneView extends LaneRef {
  experiment: string;
  variant: string;
  outcome: RepSummary["outcome"];
  broken: string[];
  error?: string;
  durationMs: number;
  diff: string;
}

export interface LaneRequest {
  id: number;
  method: string;
  path: string;
  status?: number;
  failure?: string;
  harness?: string[];
  start: number;
  end?: number;
  /** Statements it ran, and how many wrote. */
  sql?: { total: number; writes: number; errors: number };
  /** Where this lane first differs from the reference lane. */
  divergent?: boolean;
}

export interface LaneStep {
  start: number;
  end: number;
  /** Database writes in this row, when they can't all be put on one request (overlapping webhook deliveries). */
  writes?: number;
  as?: string;
  error?: string;
  harness: string[];
  quiet: boolean;
  requests: LaneRequest[];
  /** What the page said when the step ended. */
  seen?: { path: string; text: string };
  /** This step is where the page first said something else than in the reference lane. */
  seenDiffers?: boolean;
}

export interface AlignedRow {
  tab: string;
  /** Step name; `(outside a step)` for requests between steps, `(payment webhooks)` for deliveries. */
  step: string;
  attempt?: string;
  cells: (LaneStep | null)[];
}

export interface Divergence {
  tab: string;
  at: number;
  /** Row of `rows` it falls in. */
  row: number;
  /** This lane's request there, and the reference lane's (`(nothing)` when one ran out). */
  ours: string;
  theirs: string;
}

export interface Comparison {
  lanes: LaneView[];
  /** Steps of every lane, lined up by tab and step name. */
  rows: AlignedRow[];
  /** Index of the lane the others are compared with (the first that held every rule); -1 when none did. */
  reference: number;
  /** Per lane: where it first differs from the reference; null for the reference and for lanes that don't differ. */
  divergence: (Divergence | null)[];
}

const OUTSIDE = "(outside a step)";
const WEBHOOKS = "(payment webhooks)";

/** Runs side by side, steps lined up, with where each first differs from one that held every rule. */
export async function compareLanes(store: RunStore, refs: LaneRef[]): Promise<Comparison> {
  const loaded: { ref: LaneRef; rep: LoadedRep; experiment: string }[] = [];
  for (const ref of refs) {
    const dir = runDir(store, ref.run);
    if (!(await exists(join(store.repDir(dir, ref.rep), "result.json")))) throw new Error(`run ${ref.run} has no finished repetition ${ref.rep}`);
    const experiment = (await readJson<Experiment>(join(dir, "experiment.json")))?.id ?? "?";
    loaded.push({ ref, rep: await loadRep(store, ref.run, ref.rep), experiment });
  }
  const lanes = loaded.map(({ ref, rep, experiment }): LaneView => ({
    ...ref,
    experiment,
    variant: rep.detail.variant,
    outcome: rep.detail.outcome,
    broken: rep.detail.broken ?? [],
    ...(rep.detail.error ? { error: rep.detail.error } : {}),
    durationMs: rep.detail.durationMs,
    diff: rep.detail.diff ?? "",
  }));

  const key = (tab: string, step: string, attempt?: string) => `${tab}\u0000${step}\u0000${attempt ?? ""}`;
  const cells = loaded.map(({ rep }) => laneCells(rep));
  // Merge each lane's sequence of rows into one order, keeping every lane's own order.
  const order: string[] = [];
  const info = new Map<string, { tab: string; step: string; attempt?: string }>();
  for (const lane of cells) {
    let last = -1;
    for (const [k, c] of lane) {
      const at = order.indexOf(k);
      if (at >= 0) last = Math.max(last, at);
      else {
        order.splice(last + 1, 0, k);
        last++;
        info.set(k, { tab: c.tab, step: c.step, ...(c.attempt ? { attempt: c.attempt } : {}) });
      }
    }
  }
  // Webhooks and stray requests go last.
  const rank = (k: string) => (info.get(k)!.step === WEBHOOKS ? 2 : info.get(k)!.step === OUTSIDE ? 1 : 0);
  const sorted = order.map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
  const rows: AlignedRow[] = sorted.map((k) => ({ ...info.get(k)!, cells: cells.map((lane) => lane.get(k)?.cell ?? null) }));

  const reference = lanes.findIndex((l) => l.outcome === "ok");
  const divergence = loaded.map(({ rep }, i): Divergence | null => {
    if (reference < 0 || i === reference) return null;
    const first = firstDifference(rep, loaded[reference]!.rep);
    if (!first) return writesDiffer(rows, i, reference) ?? pageDiffers(rows, rep, loaded[reference]!.rep, i, reference);
    const mark = (lane: number, r: RequestRecord | undefined) => {
      if (!r) return -1;
      const row = rows.findIndex((x) => x.tab === r.tab && x.cells[lane]?.requests.some((q) => q.id === r.id));
      if (row >= 0) for (const q of rows[row]!.cells[lane]!.requests) if (q.id === r.id) q.divergent = true;
      return row;
    };
    const ours = mark(i, first.ours);
    const theirs = mark(reference, first.theirs);
    const show = (r: RequestRecord | undefined) => (r ? `${r.step ?? "outside a step"}: ${requestLine(r, {})}` : "(nothing)");
    return { tab: first.tab, at: first.at, row: ours >= 0 ? ours : theirs, ours: show(first.ours), theirs: show(first.theirs) };
  });
  return { lanes, rows, reference, divergence };
}

/** Same requests and writes in both lanes: the first step after which the page said something else. */
function pageDiffers(rows: AlignedRow[], ours: LoadedRep, theirs: LoadedRep, lane: number, reference: number): Divergence | null {
  const page = pageDifference(ours, theirs);
  if (!page) return null;
  const [step, attempt] = page.step.match(/^(.*?)(?: \((.+)\))?$/)!.slice(1);
  const row = rows.findIndex((r) => r.tab === page.tab && r.step === step && (r.attempt ?? undefined) === attempt);
  for (const l of [lane, reference]) {
    const cell = rows[row]?.cells[l];
    if (cell) cell.seenDiffers = true;
  }
  return { tab: page.tab, at: rows[row]?.cells[lane]?.end ?? 0, row, ours: `${page.step}: page said "${page.ours}"`, theirs: `"${page.theirs}"` };
}

/** Same requests in both lanes: the first whose database writes differ (a duplicate webhook that wrote twice). */
function writesDiffer(rows: AlignedRow[], lane: number, reference: number): Divergence | null {
  const label = (q: LaneRequest) => `${q.method} ${q.path} ${q.failure ? `✗ ${q.failure}` : (q.status ?? "no answer")}`;
  const writes = (q: LaneRequest | undefined) => q?.sql?.writes ?? 0;
  for (const [row, r] of rows.entries()) {
    const ours = r.cells[lane]?.requests ?? [];
    const theirs = r.cells[reference]?.requests ?? [];
    for (let j = 0; j < Math.max(ours.length, theirs.length); j++) {
      if (writes(ours[j]) === writes(theirs[j])) continue;
      if (ours[j]) ours[j]!.divergent = true;
      if (theirs[j]) theirs[j]!.divergent = true;
      const show = (q: LaneRequest | undefined) => (q ? `${r.step}: ${label(q)} · ${writes(q)} write${writes(q) === 1 ? "" : "s"}` : "(nothing)");
      return { tab: r.tab, at: ours[j]?.start ?? theirs[j]!.start, row, ours: show(ours[j]), theirs: show(theirs[j]) };
    }
    const [a, b] = [r.cells[lane]?.writes, r.cells[reference]?.writes];
    if (a !== undefined && b !== undefined && a !== b) {
      const show = (n: number, list: LaneRequest[]) => `${r.step}: ${list.length} ${r.tab === "webhooks" ? "deliver" : "request"}${list.length === 1 ? (r.tab === "webhooks" ? "y" : "") : r.tab === "webhooks" ? "ies" : "s"} · ${n} write${n === 1 ? "" : "s"}`;
      return { tab: r.tab, at: r.cells[lane]!.start, row, ours: show(a, ours), theirs: show(b, theirs) };
    }
  }
  return null;
}

/** A lane's steps (and the requests in each) keyed by tab, step and attempt, in time order. */
function laneCells(rep: LoadedRep): Map<string, { tab: string; step: string; attempt?: string; cell: LaneStep }> {
  const counts = rep.sql ? sqlCounts(rep.sql) : undefined;
  const out = new Map<string, { tab: string; step: string; attempt?: string; cell: LaneStep }>();
  const used = new Set<number>();
  const view = (r: RequestRecord): LaneRequest => {
    used.add(r.id);
    const sql = counts?.get(r.id);
    return {
      id: r.id,
      method: r.method,
      path: cleanPath(r.url),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.failure ? { failure: r.failure } : {}),
      ...(r.harness?.length ? { harness: r.harness } : {}),
      start: r.start,
      ...(r.end !== undefined ? { end: r.end } : {}),
      ...(sql ? { sql } : {}),
    };
  };
  const steps = [...rep.detail.steps].sort((a, b) => a.start - b.start);
  for (const s of steps) {
    const requests = rep.requests.filter((r) => r.tab === s.tab && r.start >= s.start && r.start < (s.end || Infinity) && interesting(r) && !used.has(r.id));
    let k = `${s.tab}\u0000${s.step}\u0000${s.attempt ?? ""}`;
    // The same step twice without an attempt label (a flow loop): number them.
    for (let n = 2; out.has(k); n++) k = `${s.tab}\u0000${s.step}\u0000${s.attempt ?? ""} #${n}`;
    out.set(k, {
      tab: s.tab,
      step: s.step,
      ...(s.attempt ? { attempt: s.attempt } : {}),
      cell: {
        start: s.start,
        end: s.end,
        ...(s.as ? { as: s.as } : {}),
        ...(s.error ? { error: s.error } : {}),
        harness: s.harness ?? [],
        quiet: s.quiet,
        requests: requests.map(view),
        ...(s.seen ? { seen: s.seen } : {}),
      },
    });
  }
  const stray = new Map<string, RequestRecord[]>();
  for (const r of rep.requests) {
    if (used.has(r.id) || !interesting(r)) continue;
    stray.set(r.tab, [...(stray.get(r.tab) ?? []), r]);
  }
  for (const [tab, list] of stray) {
    out.set(`${tab}\u0000${OUTSIDE}\u0000`, {
      tab,
      step: OUTSIDE,
      cell: { start: list[0]!.start, end: list.at(-1)!.end ?? list.at(-1)!.start, harness: [], quiet: true, requests: list.map(view) },
    });
  }
  const t0 = rep.detail.startedAt ? Date.parse(rep.detail.startedAt) : undefined;
  const deliveries = rep.detail.webhooks.flatMap((w) => w.deliveries.map((d) => ({ w, d, at: t0 !== undefined ? Date.parse(d.at) - t0 : 0 })));
  if (deliveries.length) {
    deliveries.sort((a, b) => a.at - b.at);
    out.set(`webhooks\u0000${WEBHOOKS}\u0000`, {
      tab: "webhooks",
      step: WEBHOOKS,
      cell: {
        start: deliveries[0]!.at,
        end: deliveries.at(-1)!.at + (deliveries.at(-1)!.d.ms ?? 0),
        harness: [],
        quiet: true,
        ...(rep.sql ? { writes: rep.sql.filter((s) => s.sources.some((x) => x.label.startsWith("webhook ")) && writeTarget(s.sql)).length } : {}),
        requests: deliveries.map(({ w, d, at }, i) => {
          // The statements this delivery ran, when no other delivery was being handled at the same time.
          const end = (x: { at: number; d: { ms?: number } }) => x.at + (x.d.ms ?? 10_000);
          const alone = deliveries.every((o, j) => j === i || end(o) < at || o.at > end({ at, d }));
          const ran = (rep.sql ?? []).filter((s) => s.sources.some((x) => x.label === `webhook ${w.type}`) && s.at >= at - 5 && s.at <= end({ at, d }) + 5);
          return {
            id: -1 - i,
            method: "POST",
            path: `${w.path ?? "(webhook)"} ${w.type} ${w.charge}`,
            ...(d.status !== null ? { status: d.status } : {}),
            ...(d.error ? { failure: d.error } : {}),
            start: at,
            ...(d.ms !== undefined ? { end: at + d.ms } : {}),
            ...(rep.sql && alone ? { sql: { total: ran.length, writes: ran.filter((s) => writeTarget(s.sql)).length, errors: ran.filter((s) => s.error).length } } : {}),
          };
        }),
      },
    });
  }
  return out;
}

function summaryOf(r: RepDetail): RepSummary {
  return {
    rep: r.rep,
    variant: r.variant,
    outcome: r.outcome,
    broken: r.broken ?? [],
    ...(r.error ? { error: r.error } : {}),
    durationMs: r.durationMs,
    diff: r.diff ?? "",
    ...(r.warnings ? { warnings: r.warnings } : {}),
  };
}

/** What the evidence helpers need of a run that has not finished: its id and experiment. */
function partialResult(id: string, experiment: Experiment): ExperimentResult {
  return { runId: id, experiment: experiment.id, version: { id: "", label: "" }, outcome: "error", variants: [], reps: [], startedAt: "", durationMs: 0, dir: "" };
}

function runDir(store: RunStore, id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`bad run id: ${id}`);
  return join(store.dir, id);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text ? (JSON.parse(text) as T) : undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

function cleanPath(url: string): string {
  const rsc = /[?&]_rsc=/.test(url);
  return url.replace(/([?&])_rsc=[^&]*/, "$1").replace(/[?&]$/, "") + (rsc ? " (RSC)" : "");
}

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git } from "../git.ts";
import type { Rule, RuleResult } from "../rules.ts";
import { viewerLink } from "../viewer-state.ts";
import type { DbDiff, Row } from "./db-diff.ts";
import type { Experiment } from "./experiment.ts";
import type { RaceRecord, RequestRecord } from "./network.ts";
import type { ConsoleRecord, FlowError, StepRecord, WebhookRecord } from "./rep.ts";
import type { ExperimentResult, RepSummary } from "./runner.ts";
import { CONTROL_ROLES, describeElement, formatSnapshot, type PageSnapshot } from "./snapshot.ts";
import type { RunStore } from "./store.ts";
import {
  attribute,
  mentions,
  narrowByCode,
  type SqlStatement,
  sqlCounts,
  statementLine,
  type TraceContext,
  type TracedStatement,
  traceLines,
  writeTarget,
} from "./trace.ts";

/** About 2k tokens: the packet a model reads first. */
export const PACKET_CHARS = 8_000;
/** About 4k tokens: the most any drill-down returns. */
export const DRILL_CHARS = 16_000;

export interface EvidenceOptions {
  /** Current rules, for descriptions and SQL. */
  rules?: Rule[];
  /** Maps a request to the file that handles it (from the app map). */
  handlerFor?: (method: string, path: string) => string | undefined;
  /** The repository, to find each statement's line in the code the run used. */
  source?: { repoRoot: string; appSubdir: string };
  maxChars?: number;
}

/** A run's result.json: its summary plus what happened in it. */
export interface RepDetail extends RepSummary {
  startedAt?: string;
  rules: RuleResult[];
  errors: FlowError[];
  steps: StepRecord[];
  race?: RaceRecord;
  webhooks: WebhookRecord[];
  charges: { id: string; amount: number; idempotencyKey: string | null; metadata: Record<string, string> }[];
  chargeCalls?: { at: number; charge: string; replayed: boolean }[];
  console: ConsoleRecord[];
  traces: string[];
}

export interface LoadedRep {
  detail: RepDetail;
  requests: RequestRecord[];
  diff?: DbDiff;
  /** The app's statements linked to requests; undefined when SQL was not logged. */
  sql?: TracedStatement[];
}

/** Everything a model needs to judge one run, in about 2k tokens, with handles to drill down. */
export async function evidencePacket(store: RunStore, runId: string, options: EvidenceOptions = {}): Promise<string> {
  const run = (await store.read(runId)) as ExperimentResult;
  const dir = join(store.dir, runId);
  const experiment = JSON.parse(await readFile(join(dir, "experiment.json"), "utf8")) as Experiment;
  const focus = pickRep(run);
  const rep = await loadRep(store, runId, focus.rep);
  const ctx = await traceContext(run, rep, options);
  const rules = new Map((options.rules ?? []).map((r) => [r.id, r]));

  const sections: { text: string; priority: number }[] = [];
  const add = (priority: number, lines: (string | false | undefined)[]) => {
    const text = lines.filter((l): l is string => typeof l === "string").join("\n");
    if (text) sections.push({ text, priority });
  };

  add(0, [
    `Run ${runId} · ${run.experiment} · version ${run.version.id} (${run.version.label})`,
    experiment.description && `"${experiment.description}"`,
    `Result: ${run.outcome.toUpperCase()} — ${resultLine(run)}`,
    ...(run.variants.length > 1 ? run.variants.map((v) => `  ${v.variant}: ${v.outcome} (${v.ok} ok, ${v.broken} broken, ${v.errors} error)`) : []),
    ...(run.warnings ?? []).map((w) => `Not exercised: ${w}`),
    `Showing run #${focus.rep}${focus.variant !== "default" ? ` [${focus.variant}]` : ""} (${focus.outcome})${rep.detail.error ? `: ${rep.detail.error}` : ""}`,
  ]);

  const triage = JSON.parse(await readFile(join(dir, "triage.json"), "utf8").catch(() => "null")) as {
    label?: string;
    reason: string;
    by: string;
    decision?: string;
    rerun?: { runId: string; outcome: string };
  } | null;
  if (triage) {
    add(0, [
      `Sorted as: ${triage.label ? triage.label.replace("-", " ") : "undecided"} — ${triage.reason} [${triage.by}]${triage.decision && !triage.label ? ` (windtunnel_decide id=${triage.decision})` : ""}`,
      triage.rerun && `Re-ran after healing: run ${triage.rerun.runId} ${triage.rerun.outcome}`,
    ]);
  }

  for (const e of rep.detail.errors.filter((e) => e.page)) {
    const page = e.page!;
    const snapshot = e.snapshot ? await readSnapshot(store, runId, focus.rep, e.snapshot) : undefined;
    add(1, [
      `Page when ${e.tab}${e.step ? ` / ${e.step}` : ""} failed: ${page.path}${page.alerts.length ? ` · alert: ${page.alerts.map((a) => `"${a}"`).join(", ")}` : ""}`,
      `  text: "${page.text}"`,
      e.locator &&
        `  ${e.locator.action} waited for ${e.locator.locator}${e.locator.matched ? ` and found ${e.locator.matched} elements` : ", not on the page"}`,
      snapshot &&
        `  controls there: ${snapshot.elements
          .filter((x) => CONTROL_ROLES.has(x.role) || x.clickable)
          .slice(0, 14)
          .map(describeElement)
          .join(" · ") || "none"} (all, with locators: drill down "${runId}/${focus.rep}/page")`,
    ]);
  }

  for (const r of rep.detail.rules.filter((r) => !r.ok)) {
    const rule = rules.get(r.id);
    add(1, [
      `Rule ${r.id} ${r.error ? "could not run" : "broken"}${rule?.description ? ` — ${rule.description}` : ""}`,
      r.error ? `  error: ${r.error}` : `  rows: ${r.rows.slice(0, 5).map(inline).join(" · ")}${r.rows.length > 5 ? ` (+${r.rows.length - 5})` : ""}`,
    ]);
  }

  add(2, ["Steps (ms from start; requests other than page loads; [harness] = what Wind Tunnel did):", ...timeline(rep, options)]);

  if (rep.detail.race) {
    const race = rep.detail.race;
    const label = (tab: string, arrival: number) => `${tab} (${ordinal(arrival)} to arrive)`;
    const released = race.released.map((r) => {
      const m = /^(.*)#(\d+)$/.exec(r);
      return m ? label(m[1]!, Number(m[2])) : r;
    });
    add(3, [
      `Race on ${race.request}: held ${race.arrived.map((a) => label(a.tab, a.arrival)).join(", ")}; released ${released.length === 1 ? released[0] : released.join(", then ")}${race.timedOut ? " (timed out waiting for more)" : ""}`,
    ]);
  }
  if (rep.detail.webhooks.length || rep.detail.charges.length) {
    const t0 = rep.detail.startedAt ? Date.parse(rep.detail.startedAt) : undefined;
    add(3, [
      rep.detail.charges.length > 0 &&
        `Charges: ${rep.detail.charges.map((c) => `${c.id} ${c.amount} (order ${c.metadata.order_id ?? "?"}, ${c.idempotencyKey ? `key ${c.idempotencyKey}` : "no idempotency key"})`).join(" · ")}`,
      rep.detail.webhooks.length > 0 &&
        `Webhooks: ${rep.detail.webhooks
          .map((w) => `${w.event} ${w.type} ${w.charge} → ${w.deliveries.map((d) => `${d.status ?? d.error ?? "?"}${t0 ? ` @${Date.parse(d.at) - t0}` : ""}`).join(", ") || "not delivered"}`)
          .join(" · ")}`,
    ]);
  }

  const handlers = handlerLines(rep.requests, options);
  if (handlers.length) add(3, [`Handlers: ${handlers.join(" · ")}`]);

  const brokenTables = tablesOf(rep.detail.rules.filter((r) => !r.ok).map((r) => rules.get(r.id)?.sql ?? ""));
  if (rep.sql && (brokenTables.length || rep.diff?.summary)) {
    // The tables a broken rule reads; without one, those the rules read that the run changed, then the rest it changed.
    const only = brokenTables.length > 0;
    const lines = traceLines(rep.sql, rep.diff, only ? brokenTables : ruleTables(rep, options), ctx, { perTable: 6, tables: 4, only });
    if (lines.length) {
      add(3, [`Trace (request → handler → SQL → result) of the ${only ? "tables the broken rules read" : "tables the rules read, then the others the run changed"} (every table: drill down "trace"):`, ...lines]);
    }
  }
  if (rep.diff) add(4, [`Database changes: ${rep.diff.summary}`, ...diffLines(rep.diff, brokenTables, 3)]);

  const contrast = await divergence(store, run, focus, rep);
  if (contrast.length) add(4, contrast);

  const logErrors = await appErrors(store, runId, focus.rep, 5);
  // A 4xx the request log already shows ("Failed to load resource … 409") says nothing new.
  const consoleErrors = rep.detail.console
    .filter((c) => c.type === "error" && !/Failed to load resource: the server responded with a status of 4\d\d/.test(c.text))
    .slice(0, 3);
  if (logErrors.length || consoleErrors.length) {
    add(5, [
      ...logErrors.map((l) => `app log: ${l}`),
      ...consoleErrors.map((c) => `browser console (${c.tab}${c.step ? ` / ${c.step}` : ""}): ${c.text}`),
    ]);
  }

  const h = `${runId}/${focus.rep}`;
  // A running viewer shows this run with its timelines lined up; the link is for the person.
  const link = await viewerLink(dirname(store.dir), `/run/${runId}/${focus.rep}`);
  add(0, [
    `Drill down: windtunnel_evidence handle "${h}/<part>", part = steps · requests · sql · sql:<table> · trace · diff · diff:<table> · rule:<id> · page · log · console · webhooks (other runs: ${runId}/1…${run.reps.length})`,
    rep.detail.traces.length > 0 && `Playwright trace: ${rep.detail.traces.map((t) => `npx playwright show-trace ${t}`).join(" · ")}`,
    link && `Viewer: ${link}`,
  ]);

  return fit(sections, options.maxChars ?? PACKET_CHARS);
}

/**
 * Detail behind a packet: `<run>`, `<run>/<rep>`,
 * `<run>/<rep>/steps|requests|sql|sql:<table>|trace|diff|diff:<table>|rule:<id>|page|log|console|webhooks`.
 */
export async function drillDown(store: RunStore, handle: string, options: EvidenceOptions = {}): Promise<string> {
  const [runId, repText, what = "", ...rest] = handle.split("/");
  if (!runId) throw new Error("empty handle");
  if (!repText) return evidencePacket(store, runId, options);
  const repNo = Number(repText);
  const run = (await store.read(runId)) as ExperimentResult;
  if (!Number.isInteger(repNo) || !run.reps.some((r) => r.rep === repNo)) {
    throw new Error(`run ${runId} has runs 1–${run.reps.length}; got "${repText}"`);
  }
  const rep = await loadRep(store, runId, repNo);
  const ctx = await traceContext(run, rep, options);
  const item = [what, ...rest].join("/");
  let text: string;
  if (item === "") {
    const summary = run.reps.find((r) => r.rep === repNo)!;
    text = [`Run ${runId} #${repNo} [${summary.variant}] ${summary.outcome}${summary.error ? `: ${summary.error}` : ""}`, ...timeline(rep, options)].join("\n");
  } else if (item === "steps") {
    text = rep.detail.steps
      .map((s) => [
        `${s.tab}${s.as ? ` (as ${s.as})` : ""} ${s.step}${s.attempt ? ` (${s.attempt})` : ""} ${s.start}–${s.end}${s.quiet ? "" : " (network never went quiet)"}${s.error ? ` ERROR ${s.error}` : ""}`,
        ...(s.harness ?? []).map((n) => `  [harness] ${n}`),
        ...s.actions.map((a) => `  ${a.at} ${a.action}`),
      ].join("\n"))
      .join("\n");
  } else if (item === "requests") {
    const counts = rep.sql ? sqlCounts(rep.sql) : undefined;
    text = rep.requests.map((r) => requestLine(r, options, true, counts)).join("\n");
  } else if (item === "sql" || item.startsWith("sql:")) {
    const table = item.slice(4);
    if (!rep.sql) text = "no SQL log for this run (db.sqlLog is off, or the run did not start)";
    else {
      const statements = table ? rep.sql.filter((s) => mentions(s.sql, table)) : rep.sql;
      text = statements.map((s) => statementLine(s, ctx, true)).join("\n") || (table ? `no statement mentions ${table}` : "the app ran no SQL");
    }
  } else if (item === "trace") {
    if (!rep.sql) text = "no SQL log for this run (db.sqlLog is off, or the run did not start)";
    else {
      const broken = tablesOf(rep.detail.rules.filter((r) => !r.ok).map((r) => options.rules?.find((x) => x.id === r.id)?.sql ?? ""));
      text = traceLines(rep.sql, rep.diff, broken.length ? broken : ruleTables(rep, options), ctx, { perTable: 50, tables: 50 }).join("\n") || "no table changed and no rule broke";
    }
  } else if (item === "diff" || item.startsWith("diff:")) {
    if (!rep.diff) text = "no database diff for this run";
    else {
      const table = item.slice(5);
      const tables = table ? { [table]: rep.diff.tables[table] } : rep.diff.tables;
      if (table && !rep.diff.tables[table]) text = `no changes in ${table} (changed: ${Object.keys(rep.diff.tables).join(", ") || "none"})`;
      else {
        const lines = diffLines({ ...rep.diff, tables: tables as DbDiff["tables"] }, Object.keys(tables), 50);
        text = (table ? lines : [`Database changes: ${rep.diff.summary}`, ...lines]).join("\n");
      }
    }
  } else if (item.startsWith("rule:")) {
    const id = item.slice(5);
    const result = rep.detail.rules.find((r) => r.id === id);
    const rule = options.rules?.find((r) => r.id === id);
    if (!result) text = `rule ${id} was not checked in this run (checked: ${rep.detail.rules.map((r) => r.id).join(", ")})`;
    else {
      text = [
        `Rule ${id}: ${result.ok ? "held" : result.error ? `error: ${result.error}` : "broken"}${rule?.description ? ` — ${rule.description}` : ""}`,
        rule && `SQL: ${rule.sql.replace(/\s+/g, " ").trim()}`,
        ...result.rows.map((r) => `  ${inline(r)}`),
      ].filter(Boolean).join("\n");
    }
  } else if (item === "page") {
    const pages = await Promise.all(
      rep.detail.errors.filter((e) => e.snapshot).map(async (e) => ({ e, snapshot: await readSnapshot(store, runId, repNo, e.snapshot!) })),
    );
    text =
      pages
        .filter((p) => p.snapshot)
        .map(({ e, snapshot }) => [`${e.tab}${e.step ? ` / ${e.step}` : ""}: ${e.message}`, formatSnapshot(snapshot!, { max: 150 })].join("\n"))
        .join("\n\n") || "no page snapshot: the flow did not fail on a page in this run";
  } else if (item === "log") {
    const log = await readFile(join(store.repDir(join(store.dir, runId), repNo), "app.log"), "utf8").catch(() => "");
    text = log.trim().split("\n").slice(-120).join("\n") || "app log is empty";
  } else if (item === "console") {
    text = rep.detail.console.map((c) => `${c.at} ${c.tab}${c.step ? ` / ${c.step}` : ""} ${c.type}: ${c.text}`).join("\n") || "no console messages";
  } else if (item === "webhooks") {
    text = [
      ...rep.detail.charges.map((c) => `charge ${c.id} ${c.amount} ${inline(c.metadata)} idempotency key: ${c.idempotencyKey ?? "none"}`),
      ...rep.detail.webhooks.map((w) => `event ${w.event} ${w.type} ${w.charge}: ${w.deliveries.map((d) => `${d.at} → ${d.status ?? d.error}`).join(", ") || "not delivered"}`),
    ].join("\n") || "no payments in this run";
  } else {
    throw new Error(`unknown handle part "${item}": use steps, requests, sql, sql:<table>, trace, diff, diff:<table>, rule:<id>, page, log, console or webhooks`);
  }
  return cut(text, options.maxChars ?? DRILL_CHARS, handle);
}

/** The run to show: the first that broke a rule, else the first error, else the first. */
export function pickRep(run: ExperimentResult): RepSummary {
  return run.reps.find((r) => r.outcome === "broken") ?? run.reps.find((r) => r.outcome === "error") ?? run.reps[0]!;
}

/** One run's files, with its SQL linked to the requests that ran it. */
export async function loadRep(store: RunStore, runId: string, rep: number): Promise<LoadedRep> {
  const dir = store.repDir(join(store.dir, runId), rep);
  const read = async <T>(name: string): Promise<T | undefined> =>
    JSON.parse(await readFile(join(dir, name), "utf8").catch(() => "null")) ?? undefined;
  // Runs that could not start have a summary only.
  const detail = { rules: [], errors: [], steps: [], webhooks: [], charges: [], console: [], traces: [], ...((await read<Partial<RepDetail>>("result.json")) ?? {}) } as RepDetail;
  const requests = (await read<RequestRecord[]>("requests.json")) ?? [];
  const sql = await read<{ statements: SqlStatement[] }>("sql.json");
  return {
    detail,
    requests,
    diff: await read<DbDiff>("db-diff.json"),
    sql: sql && attribute(sql.statements, requests, detail.webhooks, detail.startedAt),
  };
}

async function readSnapshot(store: RunStore, runId: string, rep: number, file: string): Promise<PageSnapshot | undefined> {
  const text = await readFile(join(store.repDir(join(store.dir, runId), rep), file), "utf8").catch(() => undefined);
  return text ? (JSON.parse(text) as PageSnapshot) : undefined;
}

function resultLine(run: ExperimentResult): string {
  const runs = run.reps.length;
  const rules = new Map<string, number>();
  for (const r of run.reps) for (const id of r.broken) rules.set(id, (rules.get(id) ?? 0) + 1);
  const broken = [...rules].map(([id, n]) => `${id} broken in ${n}/${runs} runs`);
  const errors = run.reps.filter((r) => r.outcome === "error").length;
  return [...broken, errors ? `${errors}/${runs} runs errored` : "", broken.length || errors ? "" : `every rule held in ${runs}/${runs} runs`]
    .filter(Boolean)
    .join(", ");
}

/** False for request noise: page loads and React Server Component fetches that went fine. */
export function interesting(r: RequestRecord): boolean {
  if (r.harness?.length) return true;
  if (r.failure && !(r.failure === "net::ERR_ABORTED" && /[?&]_rsc=/.test(r.url))) return true;
  if ((r.status ?? 0) >= 400) return true;
  return r.method !== "GET" || (r.type !== "document" && !/[?&]_rsc=/.test(r.url));
}

export function requestLine(
  r: RequestRecord,
  options: EvidenceOptions,
  all = false,
  counts?: Map<number, { total: number; writes: number; errors: number }>,
): string {
  // React Server Component fetches (client navigation, refresh, prefetch) look like page paths.
  const rsc = /[?&]_rsc=/.test(r.url);
  const path = r.url.replace(/([?&])_rsc=[^&]*/, "$1").replace(/[?&]$/, "") + (rsc ? " (RSC)" : "");
  const outcome =
    r.failure && r.status !== undefined
      ? `${r.status}, then ✗ ${r.failure}`
      : r.failure
        ? `✗ ${r.failure}`
        : r.status !== undefined
          ? String(r.status)
          : "no answer";
  const timing = `${r.start}${r.end !== undefined ? `–${r.end}` : ""}`;
  const handler = all ? options.handlerFor?.(r.method, path) : undefined;
  const c = counts?.get(r.id);
  const sql = c ? ` · SQL ${c.total}${c.writes ? `, ${c.writes} write${c.writes > 1 ? "s" : ""}` : ""}${c.errors ? `, ${c.errors} failed` : ""}` : "";
  return `${all ? `${timing} ${r.tab}${r.step ? ` / ${r.step}` : ""} ` : ""}${r.method} ${path} ${outcome}${sql}${(r.harness ?? []).map((h) => ` [harness] ${h}`).join("")}${handler ? ` → ${handler}` : ""}`;
}

function timeline(rep: LoadedRep, options: EvidenceOptions): string[] {
  const lines: string[] = [];
  const counts = rep.sql ? sqlCounts(rep.sql) : undefined;
  for (const s of rep.detail.steps) {
    const reqs = rep.requests.filter((r) => r.tab === s.tab && r.start >= s.start && r.start < (s.end || Infinity) && interesting(r));
    lines.push(
      `  ${s.tab}${s.as ? ` (as ${s.as})` : ""} ${s.step}${s.attempt ? ` (${s.attempt})` : ""} ${s.start}–${s.end}${(s.harness ?? []).map((h) => ` [harness] ${h}`).join("")}${s.error ? ` ERROR ${s.error}` : ""}`,
      ...reqs.map((r) => `    ${requestLine(r, options, false, counts)}`),
    );
  }
  return lines;
}

function handlerLines(requests: RequestRecord[], options: EvidenceOptions): string[] {
  if (!options.handlerFor) return [];
  const seen = new Map<string, string>();
  for (const r of requests) {
    if (r.method === "GET" && (r.type === "document" || /[?&]_rsc=/.test(r.url))) continue;
    const path = r.url.split("?")[0]!;
    const file = options.handlerFor(r.method, path);
    if (file) seen.set(`${r.method} ${path.replace(/\/\d+(?=\/|$)/g, "/:id")}`, file);
  }
  return [...seen].map(([req, file]) => `${req} → ${file}`);
}

/** Tables the run's rules read that the run changed or wrote to. */
export function ruleTables(rep: LoadedRep, options: EvidenceOptions): string[] {
  const read = tablesOf(rep.detail.rules.map((r) => options.rules?.find((x) => x.id === r.id)?.sql ?? ""));
  const touched = new Set([...Object.keys(rep.diff?.tables ?? {}), ...(rep.sql ?? []).flatMap((s) => writeTarget(s.sql)?.table ?? [])]);
  return read.filter((t) => touched.has(t) || touched.has(`public.${t}`));
}

/** Handler lookup, each statement's line in the run's own code, and the payment calls between statements. */
export async function traceContext(run: ExperimentResult, rep: LoadedRep, options: EvidenceOptions): Promise<TraceContext> {
  const orderOf = new Map(rep.detail.charges.map((c) => [c.id, c.metadata.order_id]));
  const externals = (rep.detail.chargeCalls ?? []).map((c) => ({
    at: c.at,
    text: `[payment provider] ${c.replayed ? "replayed" : "created"} charge ${c.charge}${orderOf.get(c.charge) ? ` (order ${orderOf.get(c.charge)})` : ""}`,
  }));
  const ctx: TraceContext = { handlerFor: options.handlerFor, locate: await sqlLocator(run, rep.sql, options.source), externals };
  // Before anything counts or shows statements: settle overlaps the code can settle.
  if (rep.sql) narrowByCode(rep.sql, ctx);
  return ctx;
}

/** Finds each statement's first line in the code version the run used (`git grep` in its tree). */
async function sqlLocator(
  run: ExperimentResult,
  statements: TracedStatement[] | undefined,
  source: EvidenceOptions["source"],
): Promise<((sql: string) => string[]) | undefined> {
  if (!statements?.length || !source || !run.version.tree) return undefined;
  const firstLine = (sql: string) => sql.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  // Short or generic lines (BEGIN, SELECT 1) would match anywhere.
  const patterns = [...new Set(statements.map((s) => firstLine(s.sql)))].filter((p) => p.length >= 16 && /\s/.test(p));
  if (patterns.length === 0) return undefined;
  const out = await git(["grep", "-n", "-F", ...patterns.flatMap((p) => ["-e", p]), run.version.tree, "--", source.appSubdir || "."], source.repoRoot).catch(() => "");
  const prefix = source.appSubdir ? `${source.appSubdir.split("\\").join("/")}/` : "";
  const hits: { at: string; text: string }[] = [];
  for (const line of out.split("\n")) {
    const m = /^[0-9a-f]+:(.+?):(\d+):(.*)$/.exec(line);
    if (m) hits.push({ at: `${m[1]!.startsWith(prefix) ? m[1]!.slice(prefix.length) : m[1]}:${m[2]}`, text: m[3]! });
  }
  return (sql) => {
    const p = firstLine(sql);
    return hits.filter((h) => h.text.includes(p)).map((h) => h.at);
  };
}

/** Tables a rule's SQL reads, without the seed copies it may compare with. */
export function tablesOf(sql: string[]): string[] {
  const tables = sql.flatMap((s) => [...s.matchAll(/\b(?:FROM|JOIN)\s+([\w."]+)/gi)].map((m) => m[1]!.replace(/"/g, "")));
  return [...new Set(tables.filter((t) => !t.startsWith("windtunnel_seed.")))];
}

function diffLines(diff: DbDiff, first: string[], maxRows: number): string[] {
  const names = [...new Set([...first.filter((t) => diff.tables[t]), ...Object.keys(diff.tables)])];
  const lines: string[] = [];
  for (const name of names) {
    const d = diff.tables[name]!;
    if (d.countOnly) {
      lines.push(`  ${name}: ${d.countOnly.before} → ${d.countOnly.after} rows (too large to compare row by row)`);
      continue;
    }
    if (!first.includes(name) && maxRows <= 3) continue;
    const rows = [
      ...d.added.map((r) => `+${inline(r)}`),
      ...d.removed.map((r) => `-${inline(r)}`),
      ...d.changed.map((c) => `~${inline(c.key)} ${Object.entries(c.changes).map(([k, [a, b]]) => `${k}: ${short(a)}→${short(b)}`).join(", ")}`),
    ];
    lines.push(`  ${name}: ${rows.slice(0, maxRows).join(" ")}${rows.length > maxRows ? ` (+${rows.length - maxRows})` : ""}`);
  }
  return lines;
}

/** A run to compare a failing one with: a run of the same experiment that held every rule. */
export interface Reference {
  runId: string;
  rep: RepSummary;
  /** `run #2 of this experiment`, `passing run <id> on version <v>`. */
  label: string;
}

/** A run of this experiment that held every rule (the same variant if one did): in this run, else in its latest passing run. */
export async function referenceFor(store: RunStore, run: ExperimentResult, focus: RepSummary): Promise<Reference | undefined> {
  const ok = run.reps.find((r) => r.outcome === "ok" && r.variant === focus.variant) ?? run.reps.find((r) => r.outcome === "ok");
  if (ok) return { runId: run.runId, rep: ok, label: `run #${ok.rep}${ok.variant !== "default" ? ` [${ok.variant}]` : ""} of this experiment` };
  const passing = (await store.list(200)).find((e) => e.experiment === run.experiment && e.outcome === "pass" && e.id !== run.runId);
  if (!passing) return undefined;
  const result = (await store.read(passing.id).catch(() => undefined)) as ExperimentResult | undefined;
  const r = result?.reps.find((x) => x.variant === focus.variant) ?? result?.reps[0];
  return r ? { runId: passing.id, rep: r, label: `passing run ${passing.id} on version ${passing.version}` } : undefined;
}

/** Where two runs' requests first differ: each tab's own requests compared in order, the earliest difference. */
export function firstDifference(ours: LoadedRep, theirs: LoadedRep): { tab: string; at: number; ours?: RequestRecord; theirs?: RequestRecord } | undefined {
  const key = (r: RequestRecord) => `${r.step ?? ""} ${r.method} ${r.url.split("?")[0]} ${r.failure ? "✗" : (r.status ?? "?")}${r.harness?.length ? " [harness]" : ""}`;
  // Tabs run at the same time, so compare each tab's own requests; report the earliest difference.
  let first: { at: number; ours?: RequestRecord; theirs?: RequestRecord; tab: string } | undefined;
  const tabs = new Set([...ours.requests, ...theirs.requests].map((r) => r.tab));
  for (const tab of tabs) {
    const a = ours.requests.filter((r) => r.tab === tab && interesting(r));
    const b = theirs.requests.filter((r) => r.tab === tab && interesting(r));
    let i = 0;
    while (i < a.length && i < b.length && key(a[i]!) === key(b[i]!)) i++;
    if (i === a.length && i === b.length) continue;
    const at = a[i]?.start ?? b[i]?.start ?? Number.POSITIVE_INFINITY;
    if (!first || at < first.at) first = { at, ours: a[i], theirs: b[i], tab };
  }
  return first;
}

/** Where this run first differs from a run that held every rule: in this run, or the latest passing run of the experiment. */
async function divergence(store: RunStore, run: ExperimentResult, focus: RepSummary, rep: LoadedRep): Promise<string[]> {
  if (focus.outcome === "ok") return [];
  const other = await referenceFor(store, run, focus);
  if (!other) return [];
  const theirs = await loadRep(store, other.runId, other.rep.rep);
  const first = firstDifference(rep, theirs);
  const lines = [`Compared with ${other.label}:`];
  const changed = await experimentChanged(store, run.runId, other.runId);
  if (changed) lines.push("  (that run used a different version of the experiment file)");
  if (first) {
    const show = (r: RequestRecord | undefined) => (r ? `${r.step ?? "outside a step"}: ${requestLine(r, {})}` : "(nothing)");
    lines.push(`  first difference, tab ${first.tab}: this run ${show(first.ours)} — that run ${show(first.theirs)}`);
  } else lines.push("  same requests in the same order");
  lines.push(`  database changes there: ${other.rep.diff || "none"}`);
  return lines;
}

export async function experimentChanged(store: RunStore, a: string, b: string): Promise<boolean> {
  const read = (id: string) => readFile(join(store.dir, id, "experiment.json"), "utf8").catch(() => "");
  const [x, y] = await Promise.all([read(a), read(b)]);
  return x !== "" && y !== "" && x !== y;
}

function ordinal(n: number): string {
  return `${n}${n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th"}`;
}

async function appErrors(store: RunStore, runId: string, rep: number, max: number): Promise<string[]> {
  const log = await readFile(join(store.repDir(join(store.dir, runId), rep), "app.log"), "utf8").catch(() => "");
  return log
    .split("\n")
    .filter((l) => /\b(error|exception|unhandled|failed)\b/i.test(l) && !/^\s*at /.test(l))
    .slice(0, max)
    .map((l) => l.trim().slice(0, 200));
}

/** Keeps every section that fits, most important first, in their original order. */
function fit(sections: { text: string; priority: number }[], max: number): string {
  const order = sections.map((s, i) => ({ ...s, i })).sort((a, b) => a.priority - b.priority || a.i - b.i);
  const kept = new Set<number>();
  let used = 0;
  const dropped: number[] = [];
  for (const s of order) {
    if (used + s.text.length + 2 <= max) {
      kept.add(s.i);
      used += s.text.length + 2;
    } else if (s.priority <= 2 && used < max - 200) {
      // Too long but essential: keep the start of it.
      sections[s.i] = { ...s, text: `${s.text.slice(0, max - used - 120)}\n  … (cut; drill down for the rest)` };
      kept.add(s.i);
      used = max - 100;
    } else dropped.push(s.i);
  }
  const out = sections.filter((_, i) => kept.has(i)).map((s) => s.text);
  if (dropped.length) out.push(`(${dropped.length} section(s) left out to stay short; drill down for details)`);
  return out.join("\n\n");
}

function cut(text: string, max: number, handle: string): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… cut at ${max} characters (${text.length} in all): narrow it, e.g. ${handle.split("/").slice(0, 2).join("/")}/diff:<table>`;
}

function inline(row: Row | Record<string, unknown>): string {
  return `{${Object.entries(row).map(([k, v]) => `${k}: ${short(v)}`).join(", ")}}`;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // Timestamps: date and time, without the zone and sub-millisecond digits.
  const ts = /^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d(?:\.\d{1,3})?)/.exec(s ?? "");
  if (ts) return `${ts[1]} ${ts[2]}`;
  return s === undefined ? "undefined" : s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

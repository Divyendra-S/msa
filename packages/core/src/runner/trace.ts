import type { SqlRecord } from "../branches/sql-log.ts";
import type { DbDiff } from "./db-diff.ts";
import type { RequestRecord } from "./network.ts";
import type { WebhookRecord } from "./rep.ts";

/** A logged statement, `at` in ms since the run started. */
export type SqlStatement = SqlRecord;

/** What sent the app the work that ran a statement: a browser request or a webhook delivery. */
export interface Source {
  /** e.g. `alice POST /api/orders` or `webhook charge.succeeded`. */
  label: string;
  method: string;
  path: string;
  /** The request in requests.json, for browser requests. */
  request?: number;
}

export interface TracedStatement extends SqlStatement {
  /** Requests running when it ran; more than one when they overlapped. Empty: none (startup, background work). */
  sources: Source[];
}

/** Start/end slack: the clocks agree, but the proxy sees a statement a little after the request arrives. */
const SLACK_MS = 5;

/**
 * Links each statement to the request(s) the app was handling when it ran. Requests run
 * one step at a time except in races; where they overlap, a transaction's statements are
 * narrowed to the requests running for the whole transaction.
 */
export function attribute(
  statements: SqlStatement[],
  requests: RequestRecord[],
  webhooks: WebhookRecord[],
  startedAt?: string,
): TracedStatement[] {
  const t0 = startedAt ? Date.parse(startedAt) : Number.NaN;
  const windows: { from: number; to: number; source: Source }[] = [];
  for (const r of requests) {
    if (r.sent === null) continue; // answered by the harness
    // Pages and server-component fetches stream, so they may query until the body ends; API calls are done when they answer.
    const streams = r.type === "document" || /[?&]_rsc=/.test(r.url);
    windows.push({
      from: (r.sent ?? r.start) - SLACK_MS,
      to: ((streams ? r.end : (r.response ?? r.end)) ?? Number.POSITIVE_INFINITY) + SLACK_MS,
      source: { label: `${r.tab} ${r.method} ${cleanPath(r.url)}`, method: r.method, path: cleanPath(r.url).split("?")[0]!, request: r.id },
    });
  }
  if (!Number.isNaN(t0)) {
    for (const w of webhooks) {
      for (const d of w.deliveries) {
        const from = Date.parse(d.at) - t0;
        windows.push({
          from: from - SLACK_MS,
          to: from + (d.ms ?? 10_000) + SLACK_MS,
          source: { label: `webhook ${w.type}`, method: "POST", path: w.path ?? "(webhook)" },
        });
      }
    }
  }
  const traced: TracedStatement[] = statements.map((s) => {
    let sources = windows.filter((w) => s.at >= w.from && s.at <= w.to).map((w) => w.source);
    // A write while a page loads and a form posts comes from the post.
    if (writeTarget(s.sql) && sources.some((x) => x.method !== "GET")) sources = sources.filter((x) => x.method !== "GET");
    return { ...s, sources };
  });
  for (const block of transactions(traced)) {
    const common = block.reduce<Source[]>((acc, s) => acc.filter((x) => s.sources.includes(x)), block[0]!.sources);
    if (common.length > 0) for (const s of block) s.sources = common;
  }
  return traced;
}

/**
 * Where the SQL is in the code tells which of several overlapping requests ran it: the one
 * whose handler file holds it (a page load doesn't run an API handler's SQL).
 */
export function narrowByCode(statements: TracedStatement[], ctx: TraceContext): void {
  const { locate, handlerFor } = ctx;
  if (!locate || !handlerFor) return;
  for (const s of statements) {
    if (s.sources.length < 2) continue;
    const files = new Set(locate(s.sql).map((l) => l.slice(0, l.lastIndexOf(":"))));
    if (files.size === 0) continue;
    const holders = s.sources.filter((x) => {
      const handler = handlerFor(x.method, x.path);
      return handler !== undefined && files.has(handler);
    });
    if (holders.length > 0) s.sources = holders;
  }
}

/** BEGIN … COMMIT/ROLLBACK runs of statements on one connection. */
function transactions(statements: TracedStatement[]): TracedStatement[][] {
  const open = new Map<number, TracedStatement[]>();
  const blocks: TracedStatement[][] = [];
  for (const s of statements) {
    if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(s.sql) && !s.tx) {
      open.set(s.conn, [s]);
      continue;
    }
    const block = open.get(s.conn);
    if (!block) continue;
    block.push(s);
    if (/^\s*(COMMIT|ROLLBACK|END)\b/i.test(s.sql)) {
      blocks.push(block);
      open.delete(s.conn);
    }
  }
  return blocks;
}

/** The table a statement writes to, if it writes. */
export function writeTarget(sql: string): { op: string; table: string } | undefined {
  const s = sql.replace(/^\s*WITH\b[\s\S]*?\)\s*(?=INSERT|UPDATE|DELETE)/i, "");
  const m =
    /^\s*(INSERT)\s+INTO\s+([\w."]+)/i.exec(s) ??
    /^\s*(UPDATE)\s+(?:ONLY\s+)?([\w."]+)/i.exec(s) ??
    /^\s*(DELETE)\s+FROM\s+(?:ONLY\s+)?([\w."]+)/i.exec(s) ??
    /^\s*(MERGE)\s+INTO\s+([\w."]+)/i.exec(s) ??
    /^\s*(TRUNCATE)\s+(?:TABLE\s+)?([\w."]+)/i.exec(s);
  return m ? { op: m[1]!.toUpperCase(), table: unquote(m[2]!) } : undefined;
}

/** Whether a statement names `table` anywhere. */
export function mentions(sql: string, table: string): boolean {
  const name = table.replace(/^public\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w.])"?${name}"?($|[^\\w])`, "i").test(sql);
}

/** A SELECT whose main table (first FROM, not a join) is `table`. */
function readsFrom(sql: string, table: string): boolean {
  const m = /^\s*SELECT\b[\s\S]*?\bFROM\s+([\w."]+)/i.exec(sql);
  return !!m && sameTable(unquote(m[1]!), table);
}

/** Rows a write changed, from its command tag (`INSERT 0 3` → 3). */
export function rowCount(tag: string | undefined): number | undefined {
  const m = /(\d+)$/.exec(tag ?? "");
  return m ? Number(m[1]) : undefined;
}

/** What the trace can add to a statement: its handler, where its SQL is in the code, calls to other services. */
export interface TraceContext {
  handlerFor?: (method: string, path: string) => string | undefined;
  /** Where a statement's SQL appears in the code, as `file:line` (app-relative). */
  locate?: (sql: string) => string[];
  /** Calls the app made to other services (the payment provider), shown between the statements. */
  externals?: { at: number; text: string }[];
}

/** One table's part of the trace chain: the statements that wrote it, the writers' reads, and outside calls between them. */
export interface TableChain {
  table: string;
  /** `+2 ~1`, `no rows changed`. */
  change: string;
  /** In time order; empty when no statement wrote to the table. */
  events: ({ at: number } & ({ statement: TracedStatement } | { external: string }))[];
  /** Statements left out over the limit. */
  more: number;
}

/**
 * The trace chain per table: which request's statement wrote to it, through which handler.
 * `tables` come first (e.g. those a broken rule reads), then every table the diff changed
 * unless `only` is set.
 */
export function traceChain(
  statements: TracedStatement[],
  diff: DbDiff | undefined,
  tables: string[],
  ctx: TraceContext,
  limits: { perTable: number; tables: number; only?: boolean },
): { tables: TableChain[]; more: string[] } {
  const changed = limits.only ? [] : Object.keys(diff?.tables ?? {});
  const all = [...new Set([...tables, ...changed])];
  const names = all.slice(0, limits.tables);
  const chains = names.map((table): TableChain => {
    const writes = statements.filter((s) => {
      const target = writeTarget(s.sql);
      return target ? sameTable(target.table, table) : !!s.error && mentions(s.sql, table);
    });
    // Reads of the table by the requests that wrote it: check-then-act shows as read, read, write, write.
    const writers = new Set(writes.flatMap((w) => w.sources));
    const reads = statements.filter(
      (s) => !writes.includes(s) && readsFrom(s.sql, table) && s.sources.length > 0 && s.sources.every((x) => writers.has(x)),
    );
    // Over the limit, writes stay and the latest reads go.
    const keepReads = Math.max(0, limits.perTable - writes.length);
    const kept = new Set([...writes, ...reads.slice(0, keepReads)]);
    const shown = statements.filter((s) => kept.has(s)).slice(0, limits.perTable);
    const d = diff?.tables[table];
    const change = d ? (d.countOnly ? `${d.countOnly.before}→${d.countOnly.after} rows` : [d.added.length && `+${d.added.length}`, d.changed.length && `~${d.changed.length}`, d.removed.length && `-${d.removed.length}`].filter(Boolean).join(" ")) : "no rows changed";
    if (writes.length === 0) return { table, change, events: [], more: 0 };
    // Calls to other services made in the middle of a request shown here: "read, then the payment, then the write".
    const same = (x: Source, y: Source) => (x.request !== undefined ? x.request === y.request : x.label === y.label);
    const during = (at: number) => shown.some((a) => a.at < at && a.sources.some((src) => shown.some((b) => b.at > at && b.sources.some((x) => same(x, src)))));
    const events = [
      ...shown.map((s) => ({ at: s.at, statement: s })),
      ...(ctx.externals ?? []).filter((e) => during(e.at)).map((e) => ({ at: e.at, external: e.text })),
    ].sort((a, b) => a.at - b.at);
    return { table, change, events, more: writes.length + reads.length - shown.length };
  });
  return { tables: chains, more: all.slice(names.length) };
}

/** The trace chain as text, one table after another. */
export function traceLines(
  statements: TracedStatement[],
  diff: DbDiff | undefined,
  tables: string[],
  ctx: TraceContext,
  limits: { perTable: number; tables: number; only?: boolean },
): string[] {
  const chain = traceChain(statements, diff, tables, ctx, limits);
  const lines: string[] = [];
  for (const t of chain.tables) {
    if (t.events.length === 0) {
      lines.push(`  ${t.table} (${t.change}): no statement wrote to it`);
      continue;
    }
    lines.push(`  ${t.table} (${t.change}):`);
    for (const e of t.events) lines.push(`    ${"statement" in e ? statementLine(e.statement, ctx) : `${e.at} ${e.external}`}`);
    if (t.more > 0) lines.push(`    … ${t.more} more (drill down: sql:${t.table})`);
  }
  if (chain.more.length) lines.push(`  … ${chain.more.length} more table(s): ${chain.more.join(", ")} (drill down: trace)`);
  return lines;
}

/** A statement's request(s), handler and place in the code, taken apart for display. */
export interface StatementParts {
  /** One per request path: who sent it, the request, its handler and the handler's lines holding the SQL. */
  sources: { who: string[]; what: string; handler?: string; lines: string[] }[];
  /** Where the SQL is when no handler holds it (a helper). */
  elsewhere?: string;
  write?: { op: string; table: string };
}

export function statementParts(s: TracedStatement, ctx: TraceContext = {}): StatementParts {
  const found = ctx.locate?.(s.sql) ?? [];
  const groups = new Map<string, { who: string[]; source: Source }>();
  for (const x of s.sources) {
    const what = x.label.startsWith("webhook ") ? x.label : `${x.method} ${x.label.split(" ").slice(2).join(" ")}`;
    const who = x.label.startsWith("webhook ") ? "" : x.label.split(" ")[0]!;
    const g = groups.get(what) ?? { who: [], source: x };
    if (who && !g.who.includes(who)) g.who.push(who);
    groups.set(what, g);
  }
  const sources = [...groups].map(([what, g]) => {
    const handler = ctx.handlerFor?.(g.source.method, g.source.path);
    // The same SQL on several lines of the file: name them all (route.ts:28,85).
    const lines = handler ? found.filter((l) => l.startsWith(`${handler}:`)).map((l) => l.slice(handler.length + 1)) : [];
    return { who: g.who, what, ...(handler ? { handler } : {}), lines };
  });
  const handlers = new Set(sources.flatMap((x) => x.handler ?? []));
  // SQL that lives in a helper rather than the handler: say where.
  const elsewhere = found.length && !found.some((l) => handlers.has(l.slice(0, l.lastIndexOf(":")))) ? found[0] : undefined;
  const write = writeTarget(s.sql);
  return { sources, ...(elsewhere ? { elsewhere } : {}), ...(write ? { write } : {}) };
}

/**
 * `1203 alice POST /api/orders → app/api/orders/route.ts:41: INSERT INTO orders … [2, 1] → INSERT 0 1 (c2, tx)`;
 * `full` adds the duration and keeps more of the SQL.
 */
export function statementLine(s: TracedStatement, ctx: TraceContext = {}, full = false): string {
  const parts = statementParts(s, ctx);
  const source =
    parts.sources.length === 0
      ? "(no request running)"
      : parts.sources
          .map((g) => `${g.who.length ? `${g.who.join("|")} ` : ""}${g.what}${g.handler ? ` → ${g.lines.length ? `${g.handler}:${g.lines.join(",")}` : g.handler}` : ""}`)
          .join(" or ");
  return `${s.at} ${source}: ${statementText(s, full)}${parts.elsewhere ? ` (SQL at ${parts.elsewhere})` : ""}`;
}

/** The SQL, its parameters and result, then the connection and whether it ran in a transaction (writes say when not). */
function statementText(s: TracedStatement, full: boolean): string {
  const sql = oneLine(s.sql, full ? 400 : 110);
  const params = s.params?.length ? ` [${s.params.map((p) => (p === null ? "null" : p)).join(", ")}]` : "";
  const result = s.error ? `ERROR ${s.error}` : (s.tag ?? "no result");
  const tx = s.tx ? ", tx" : writeTarget(s.sql) ? ", no tx" : "";
  return `${sql}${params} → ${result} (c${s.conn}${tx}${full ? `, ${s.ms} ms` : ""})`;
}

/** Per request: how many statements it ran, how many wrote, how many failed. */
export function sqlCounts(statements: TracedStatement[]): Map<number, { total: number; writes: number; errors: number }> {
  const counts = new Map<number, { total: number; writes: number; errors: number }>();
  for (const s of statements) {
    const write = !!writeTarget(s.sql);
    for (const source of s.sources) {
      if (source.request === undefined) continue;
      const c = counts.get(source.request) ?? { total: 0, writes: 0, errors: 0 };
      c.total++;
      if (write) c.writes++;
      if (s.error) c.errors++;
      counts.set(source.request, c);
    }
  }
  return counts;
}

function sameTable(a: string, b: string): boolean {
  return a.replace(/^public\./, "") === b.replace(/^public\./, "");
}

function unquote(name: string): string {
  return name.replace(/"/g, "");
}

function oneLine(sql: string, max: number): string {
  const s = sql.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cleanPath(url: string): string {
  return url.replace(/([?&])_rsc=[^&]*/, "$1").replace(/[?&]$/, "");
}

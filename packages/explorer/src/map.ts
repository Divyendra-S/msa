import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { FLOWS_DIR, loadExperiments, loadRules, type Project, stepNames } from "@windtunnel/core";
import { findNextRoutes, HTTP_METHODS } from "./routes.ts";
import { formatTable, naturalKeys, type TableInfo } from "./schema.ts";
import { type Effect, type FetchEffect, SourceIndex, type SqlEffect, type UiFacts, unique } from "./source.ts";
import { findAndroidApp } from "./android.ts";
import { findTauriApp } from "./tauri.ts";

export interface RouteInfo {
  method: string;
  path: string;
  file: string;
  /** First line of the comment above the handler. */
  comment?: string;
  effects: Effect[];
  /** Code patterns worth an experiment; hints, not findings. */
  flags: string[];
  /** Guards seen in the code, e.g. webhook dedupe. */
  notes: string[];
}

export interface PageInfo {
  path: string;
  file: string;
  kind: "page" | "layout";
  ui: UiFacts;
}

export interface AppMap {
  root: string;
  framework: string;
  routes: RouteInfo[];
  pages: PageInfo[];
  /** Patterns in shared helpers (e.g. a session lookup with no expiry check). */
  helperFlags: string[];
  schema?: TableInfo[];
  windtunnel: {
    users: string[];
    flows: { id: string; steps: string[]; params: string[] }[];
    experiments: { id: string; description?: string }[];
    rules: { id: string; description?: string }[];
  };
}

/** Builds the app map from source files (and the seed database's schema when given): no model involved. */
export async function buildAppMap(project: Project, options: { schema?: TableInfo[] } = {}): Promise<AppMap> {
  // A phone app's server can live in another folder (`app.dir`).
  const serverRoot = join(project.root, project.config.app?.dir ?? ".");
  const index = new SourceIndex(serverRoot);
  const { framework, routes: files } = await findNextRoutes(serverRoot);
  const routes: RouteInfo[] = [];
  const pages: PageInfo[] = [];
  const helperFlags = new Set<string>();
  const uniqueKeys = keysByTable(options.schema);
  const owners = ownersByTable(options.schema);

  for (const f of files) {
    const rel = relative(project.root, f.file);
    if (f.kind === "app" || f.kind === "pages-api" || f.kind === "action") {
      const names =
        f.kind === "app"
          ? (await index.exportedNames(f.file)).filter((n) => HTTP_METHODS.includes(n))
          : f.kind === "pages-api"
            ? ["default"]
            : (await index.exportedNames(f.file)).filter((n) => n !== "default");
      for (const h of await index.handlers(f.file, names)) {
        const method = f.kind === "app" ? h.name : f.kind === "pages-api" ? "ANY" : "ACTION";
        const path = f.kind === "action" ? h.name : f.path;
        for (const flag of helperPatterns(h.effects)) helperFlags.add(flag);
        const { flags, notes } = routeFlags(method, path, h.effects, uniqueKeys, owners);
        routes.push({ method, path, file: rel, ...(h.comment ? { comment: h.comment } : {}), effects: h.effects, flags, notes });
      }
    } else {
      const { facts } = await index.ui(f.file);
      pages.push({ path: f.path, file: rel, kind: f.kind as "page" | "layout", ui: facts });
    }
  }

  // A Tauri app: its commands are what its pages call, as `INVOKE <command>`.
  const tauri = await findTauriApp(project.root);
  for (const c of tauri?.commands ?? []) {
    const { flags, notes } = routeFlags("INVOKE", c.name, c.effects, uniqueKeys, owners);
    notes.push(c.async ? "async: calls can overlap" : "runs on the main thread, one call at a time");
    if (c.emits.length) notes.push(`emits ${c.emits.join(", ")}`);
    if (c.callers.length) notes.push(`invoked from ${c.callers.join(", ")}`);
    routes.push({ method: "INVOKE", path: c.name, file: c.file, ...(c.comment ? { comment: c.comment } : {}), effects: c.effects, flags, notes });
  }
  if (tauri && pages.length === 0) pages.push(...tauri.pages.map((p) => ({ ...p, kind: "page" as const })));

  // An Android app: its screens are the pages, and each route says where the phone calls it.
  const androidRoot = join(project.root, project.config.android?.dir ?? ".");
  const android = await findAndroidApp(androidRoot);
  if (android) {
    const prefix = relative(project.root, androidRoot);
    for (const r of routes) {
      const callers = android.calls.filter((c) => c.method === r.method && samePath(c.path, r.path));
      if (callers.length) r.notes.push(`called by the phone app: ${callers.map((c) => `${c.fn ?? "?"} (${join(prefix, c.file)}:${c.line})`).join(", ")}`);
    }
    pages.unshift(...android.screens.map((sc) => ({ path: sc.name, file: `${join(prefix, sc.file)}:${sc.line}`, kind: "page" as const, ui: sc.ui })));
  }
  const client = tauri?.framework ?? android?.framework;
  const name = client ? (framework === "unknown" ? client : `${client} + ${framework}`) : framework;

  return { root: project.root, framework: name, routes, pages, helperFlags: [...helperFlags], schema: options.schema, windtunnel: await windtunnelFiles(project) };
}

/** `/api/orders/{orderId}` (a phone's call) is `/api/orders/:id` (a route). */
function samePath(call: string, route: string): boolean {
  const norm = (p: string) => p.split("?")[0]!.replace(/\{[^}]*\}|\[[^\]]*\]|:\w+/g, "*").replace(/\/$/, "");
  return norm(call) === norm(route);
}

async function windtunnelFiles(project: Project): Promise<AppMap["windtunnel"]> {
  const flowsDir = join(project.stateDir, FLOWS_DIR);
  const flows: AppMap["windtunnel"]["flows"] = [];
  for (const name of (await readdir(flowsDir).catch(() => [])).filter((n) => /\.(ts|js|mjs)$/.test(n)).sort()) {
    const text = await readFile(join(flowsDir, name), "utf8");
    flows.push({
      id: name.replace(/\.(ts|js|mjs)$/, ""),
      steps: stepNames(text),
      params: unique([...text.matchAll(/params\.(\w+)/g)].map((m) => m[1]!)),
    });
  }
  const experiments = await loadExperiments(project).catch(() => []);
  const rules = await loadRules(project).catch(() => []);
  return {
    users: Object.keys(project.config.users),
    flows,
    experiments: experiments.map((e) => ({ id: e.id, description: e.description })),
    rules: rules.map((r) => ({ id: r.id, description: r.description })),
  };
}

interface Flat {
  effect: SqlEffect | FetchEffect;
  inTx: boolean;
  /** Inside a helper whose name looks like an auth or session check. */
  inAuth: boolean;
  /** An external call came earlier in the handler. */
  afterExternal: boolean;
  /** The outermost call passed an idempotency key (for fetches inside helpers). */
  keyPassed: boolean;
  via?: string;
}

function flatten(effects: Effect[]): Flat[] {
  const out: Flat[] = [];
  let external = false;
  const visit = (list: Effect[], ctx: { inTx: boolean; inAuth: boolean; keyPassed: boolean; via?: string }) => {
    for (const e of list) {
      if (e.kind === "tx") visit(e.effects, { ...ctx, inTx: true });
      else if (e.kind === "call") {
        visit(e.effects, { ...ctx, inAuth: ctx.inAuth || e.auth, keyPassed: ctx.keyPassed || e.keyArg, via: ctx.via ?? e.name });
      } else {
        out.push({ effect: e, ...ctx, afterExternal: external });
        if (e.kind === "fetch" && e.method !== "GET") external = true;
      }
    }
  };
  visit(effects, { inTx: false, inAuth: false, keyPassed: false });
  return out;
}

const WRITES = new Set(["INSERT", "UPDATE", "DELETE", "UPSERT"]);

function routeFlags(
  method: string,
  path: string,
  effects: Effect[],
  uniqueKeys: Map<string, string[]> | undefined,
  owners?: Map<string, string[]>,
): { flags: string[]; notes: string[] } {
  const flat = flatten(effects);
  const flags: string[] = [];
  const notes: string[] = [];
  const sql = flat.filter((f): f is Flat & { effect: SqlEffect } => f.effect.kind === "sql" && !f.inAuth);
  const writes = sql.filter((f) => WRITES.has(f.effect.op));
  const mutating = method !== "GET" && method !== "HEAD";

  // Read a table, then write it based on what was read.
  for (const [i, w] of writes.entries()) {
    const table = w.effect.tables[0]!;
    const readBefore = sql.slice(0, sql.indexOf(w)).some((r) => r.effect.op === "SELECT" && r.effect.tables.includes(table) && !r.effect.forUpdate);
    const risky = (w.effect.op === "UPDATE" || w.effect.op === "DELETE") ? !w.effect.guarded : w.effect.op === "INSERT" && !w.effect.onConflict;
    if (readBefore && risky && !writes.slice(0, i).some((x) => x.effect.tables[0] === table && x.effect.op === w.effect.op)) {
      flags.push(`check-then-act on ${table}: read, then ${w.effect.op} without a condition in the write`);
    }
  }
  for (const w of writes) {
    const e = w.effect;
    if ((e.op === "UPDATE" || e.op === "DELETE") && !e.guarded) {
      flags.push(`blind ${e.op} ${e.tables[0]} (WHERE only picks the row)${w.afterExternal ? " after an external call" : ""}`);
    } else if (w.afterExternal) {
      flags.push(`${e.op} ${e.tables[0]} after an external call`);
    }
    if (e.op === "INSERT" && !e.onConflict && (method === "POST" || method === "ACTION" || method === "ANY" || method === "INVOKE")) {
      const keys = uniqueKeys?.get(e.tables[0]!);
      if (!keys) flags.push(`INSERT ${e.tables[0]}: no ON CONFLICT (schema not loaded: check for a unique key)`);
      else if (keys.length === 0) flags.push(`INSERT ${e.tables[0]}: no ON CONFLICT and no unique key besides the id; a repeated request adds a row`);
    }
  }
  // A transaction that works from rows read before it began: they can change in between.
  const firstTx = flat.findIndex((f) => f.inTx);
  if (firstTx > 0) {
    const inside = new Set(flat.filter((f) => f.inTx && f.effect.kind === "sql").flatMap((f) => (f.effect as SqlEffect).tables));
    const before = unique(
      sql.filter((f) => !f.inTx && f.effect.op === "SELECT" && flat.indexOf(f) < firstTx).flatMap((f) => f.effect.tables),
    ).filter((t) => !inside.has(t));
    if (before.length) flags.push(`reads ${before.join(", ")} before tx{…} and not inside it: the transaction can act on stale rows`);
  }
  const outside = writes.filter((w) => !w.inTx);
  if (outside.length >= 2) flags.push(`${outside.length} writes outside a transaction (${unique(outside.map((w) => w.effect.tables[0])).join(", ")})`);

  for (const f of flat) {
    const e = f.effect;
    if (e.kind !== "fetch" || e.method === "GET") continue;
    const key = e.idempotencyKey === "always" || (e.idempotencyKey === "optional" && f.keyPassed);
    if (!key) flags.push(`external ${e.method} ${e.url}${f.via ? ` (via ${f.via})` : ""} without an idempotency key`);
  }

  // A desktop app's commands answer only its own windows: no login to check.
  if (method === "INVOKE") {
    for (const w of writes) {
      if (w.effect.op === "INSERT" && w.effect.onConflict && /\bDO\s+UPDATE\b/i.test(w.effect.text)) {
        flags.push(`upsert ${w.effect.tables[0]}: writes the row whether or not it still exists`);
      }
    }
  }
  const authed = flat.some((f) => f.inAuth) || hasAuthCall(effects);
  if (mutating && !authed && method !== "INVOKE") flags.push("no auth or signature check found");
  // A logged-in route that loads a user's row by the id in its path, without the owner in the query.
  if (authed && /\[|:/.test(path)) {
    for (const f of sql) {
      const table = f.effect.tables[0]!;
      const columns = owners?.get(table);
      if (!columns?.length || !f.effect.where || columns.some((c) => new RegExp(`\\b${c}\\b`, "i").test(f.effect.where!))) continue;
      flags.push(`${f.effect.op} ${table} by ${f.effect.where} with no owner (${columns.join("/")}) in the query: can another user reach it? (replay-as)`);
      break;
    }
  }
  if (/webhook/i.test(path)) {
    const dedupe = sql.some((f) => f.effect.op === "INSERT" && f.effect.onConflict && /event|webhook|idempot/i.test(f.effect.tables[0]!));
    if (dedupe) notes.push("webhook dedupes on event id");
    else flags.push("webhook with no event-id dedupe (providers deliver at least once, out of order, early)");
  }
  return { flags: unique(flags), notes };
}

function hasAuthCall(effects: Effect[]): boolean {
  return effects.some((e) => (e.kind === "call" && (e.auth || hasAuthCall(e.effects))) || (e.kind === "tx" && hasAuthCall(e.effects)));
}

/** Patterns in helpers, reported once. */
function helperPatterns(effects: Effect[]): string[] {
  const out: string[] = [];
  const visit = (list: Effect[], via?: { name: string; file: string }) => {
    for (const e of list) {
      if (e.kind === "call") visit(e.effects, { name: e.name, file: e.file });
      else if (e.kind === "tx") visit(e.effects, via);
      else if (e.kind === "sql" && e.op === "SELECT" && e.tables.some((t) => /session/i.test(t)) && !/expir|valid_until|now\(\)|revoked/i.test(e.where ?? "")) {
        out.push(`${via ? `${via.file} ${via.name}: ` : ""}session lookup with no expiry check (${e.text.slice(0, 90)})`);
      }
    }
  };
  visit(effects);
  return out;
}

/** Columns that say which user a row belongs to: a foreign key to a users-like table, or `user_id` / `owner_id`. */
function ownersByTable(schema: TableInfo[] | undefined): Map<string, string[]> | undefined {
  if (!schema) return undefined;
  const people = /^(users?|accounts?|customers?|members?|profiles?)$/i;
  return new Map(
    schema.map((t) => [
      t.name,
      unique([
        ...t.foreignKeys.filter((k) => people.test(k.table.split(".").pop()!)).flatMap((k) => k.columns),
        ...t.columns.filter((c) => /^(user|owner)_id$/i.test(c.name)).map((c) => c.name),
      ]),
    ]),
  );
}

function keysByTable(schema: TableInfo[] | undefined): Map<string, string[]> | undefined {
  if (!schema) return undefined;
  return new Map(schema.map((t) => [t.name, naturalKeys(t)]));
}

/** One line per effect group: `auth:getCurrentUser · SELECT carts · tx{INSERT orders ON CONFLICT … · …}`. */
export function formatEffects(effects: Effect[], max = 600): string {
  const render = (list: Effect[], keyPassed = false): string[] =>
    list.flatMap((e): string[] => {
      if (e.kind === "tx") return [`tx{ ${render(e.effects, keyPassed).join(" · ")} }`];
      if (e.kind === "call") {
        if (e.auth) return [`auth:${e.name}`];
        const inner = render(e.effects, keyPassed || e.keyArg);
        return inner.length ? [`${e.name}→${inner.length > 1 ? `{ ${inner.join(" · ")} }` : inner[0]}`] : [];
      }
      if (e.kind === "fetch") {
        const sent = e.idempotencyKey === "always" || (e.idempotencyKey === "optional" && keyPassed);
        return [`fetch ${e.method} ${e.url}${e.method !== "GET" ? (sent ? " [idempotency key sent]" : " [no idempotency key]") : ""}`];
      }
      if (e.op === "SELECT") return [`SELECT ${e.tables.join("+")}${e.forUpdate ? " FOR UPDATE" : ""}`];
      if (e.op === "INSERT" && e.text.startsWith("INSERT")) {
        const conflict = /\bON CONFLICT\b.*$/i.exec(e.text)?.[0];
        return [`INSERT ${e.tables[0]}${conflict ? ` ${conflict}` : ""}`];
      }
      return [e.text.length > 120 ? `${e.text.slice(0, 117)}…` : e.text];
    });
  const line = render(effects).join(" · ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The map as compact text. `focus` keeps routes and pages whose path or file contains it. */
export function formatAppMap(map: AppMap, options: { focus?: string; maxChars?: number } = {}): string {
  const focus = options.focus?.toLowerCase();
  const keep = (...texts: (string | undefined)[]) => !focus || texts.some((t) => t?.toLowerCase().includes(focus));
  const lines: string[] = [`App map: ${map.framework} · ${map.root}`];

  const routes = map.routes.filter((r) => keep(r.path, r.file, r.comment, formatEffects(r.effects, 10_000), ...r.flags));
  const pages = map.pages.filter((p) => keep(p.path, p.file, ...p.ui.buttons, ...p.ui.texts, ...p.ui.fields, ...p.ui.requests.map((q) => q.url)));
  if (focus && routes.length === 0 && pages.length === 0) {
    return [
      `Nothing in the map matches "${options.focus}" (it matches paths, files, handler comments, tables, requests and page text).`,
      `Routes: ${map.routes.map((r) => `${r.method} ${r.path}`).join(", ") || "none"}`,
      `Pages: ${map.pages.filter((p) => p.kind === "page").map((p) => p.path).join(", ") || "none"}`,
    ].join("\n");
  }

  const heading = map.routes.length > 0 && map.routes.every((r) => r.method === "INVOKE") ? "Commands" : "API routes and server actions";
  lines.push("", `${heading} (${routes.length}): what each handler does, in order; ! = pattern worth an experiment`);
  for (const r of routes) {
    lines.push(
      `${r.method} ${r.path}  ${r.file}${r.comment ? `  // ${r.comment}` : ""}`,
      `  ${formatEffects(r.effects) || "(no database or network calls found)"}`,
    );
    for (const f of r.flags) lines.push(`  ! ${f}`);
    for (const n of r.notes) lines.push(`  ✓ ${n}`);
  }
  if (map.helperFlags.length) {
    lines.push("", "Shared helpers");
    for (const f of map.helperFlags) lines.push(`  ! ${f}`);
  }

  // A phone app's screens are named for their code (`CartScreen`); web pages by their path.
  const screens = pages.filter((p) => !p.path.startsWith("/"));
  const webPages = pages.filter((p) => p.path.startsWith("/"));
  const sections: [string, PageInfo[]][] = [
    [`Screens (${screens.length}): buttons, field labels, texts it can show, server calls its actions lead to`, screens],
    [`Pages (${webPages.length}): buttons, form labels, texts it can show, requests its components send`, webPages],
  ];
  for (const [title, list] of sections) {
    if (list.length === 0 && title.startsWith("Screens")) continue;
    lines.push("", title);
    formatPages(lines, list);
  }

  if (map.schema) {
    lines.push("", `Database (seed snapshot, ${map.schema.length} tables)`);
    for (const t of map.schema) lines.push(formatTable(t));
  }

  const wt = map.windtunnel;
  lines.push(
    "",
    "Wind Tunnel",
    `users: ${wt.users.join(", ") || "none (add test users to windtunnel.config.yaml)"}`,
    `flows: ${wt.flows.map((f) => `${f.id}(${f.steps.join(", ")}${f.params.length ? `; params ${f.params.join(", ")}` : ""})`).join(" · ") || "none"}`,
    `rules: ${wt.rules.map((r) => r.id).join(", ") || "none"}`,
    `experiments: ${wt.experiments.map((e) => e.id).join(", ") || "none"}`,
  );
  const text = lines.join("\n");
  const max = options.maxChars ?? 12_000;
  return text.length > max ? `${text.slice(0, max)}\n… (cut at ${max} characters; pass focus to narrow it)` : text;
}

/** One line per page or screen: what it shows and what it sends. */
function formatPages(lines: string[], pages: PageInfo[]): void {
  for (const p of pages) {
    const ui = p.ui;
    const bits = [
      ui.redirects.some((r) => /login|signin/i.test(r)) ? "login required" : "",
      ui.fields.length ? `fields ${ui.fields.map((f) => `"${f}"`).join(", ")}` : "",
      ui.buttons.length ? `buttons ${ui.buttons.map((b) => `"${b}"`).join(", ")}` : "",
      ui.texts.length ? `shows ${ui.texts.slice(0, 8).map((t) => `"${t}"`).join(", ")}` : "",
      ui.requests.length ? `→ ${ui.requests.map((q) => `${q.method} ${q.url}`).join(", ")}` : "",
      p.kind === "layout" && ui.links.length ? `links ${ui.links.map((l) => `${l.text || "?"}→${l.href}`).join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`${p.kind === "layout" ? "layout " : ""}${p.path}  ${p.file}${bits.length ? `  ${bits.join(" · ")}` : ""}`);
  }
}

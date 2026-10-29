import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Experiment,
  type ExperimentResult,
  listRuns,
  loadExperiments,
  matchesRequest,
  parseRequestPattern,
  type RequestPattern,
  type RequestRecord,
  type Runner,
} from "@windtunnel/core";
import type { Workspace } from "@windtunnel/mcp";

/*
 * The app as one picture, for the Mac app's Map: its pages, the routes they call, the tables those
 * write and the services they call, all read from the code. Then, from each experiment's newest
 * run, which of them it went through, step by step, and where it pushed.
 */

type AppMap = Awaited<ReturnType<Workspace["appMap"]>>["map"];
type Effect = AppMap["routes"][number]["effects"][number];

export interface MapView {
  framework: string;
  pages: MapPage[];
  routes: MapRoute[];
  tables: string[];
  /** Calls out of the app, as `METHOD url`. */
  services: string[];
  experiments: MapExperiment[];
  crawl?: { at: string; stale: boolean };
}

export interface MapPage {
  path: string;
  file: string;
  /** A layout: around every page under its path. */
  layout: boolean;
  login: boolean;
  buttons: string[];
  fields: string[];
  texts: string[];
  /** Routes its components send requests to, as `METHOD /path`. */
  calls: string[];
  /** How the live crawl found it, per user. */
  visits: { as: string; status: number; final?: string }[];
}

export interface MapRoute {
  /** `POST /api/orders` */
  key: string;
  method: string;
  path: string;
  file: string;
  comment?: string;
  flags: string[];
  notes: string[];
  reads: string[];
  writes: string[];
  services: string[];
  /** What the handler does, in order. */
  effects: { kind: "auth" | "read" | "write" | "call"; text: string; tx: boolean }[];
  /** Called from outside the app (a payment provider), not by a page. */
  webhook: boolean;
}

export interface MapCall {
  route: string;
  count: number;
  tabs: number;
  /** Two of them, from different tabs or deliveries, were in the app at the same time. */
  together: boolean;
  failed: number;
}

export interface MapExperiment {
  id: string;
  description?: string;
  users: string[];
  /** Where it pushes, and the routes that lands on: requests sent at once, slowed or lost, a step submitted twice, a webhook sent twice. */
  pressure: { what: string; routes: string[]; step?: string }[];
  /** Its newest finished run, and the repetition the steps come from. */
  run?: { id: string; outcome: string; headline: string; startedAt: string; rep: number; reps: number; broken: string[] };
  pages: string[];
  routes: string[];
  /** Tables that run changed. */
  tables: string[];
  /** The run's steps in order, with the pages each opened and the routes it called. */
  steps: { name: string; pages: string[]; calls: MapCall[] }[];
}

export async function mapView(workspace: Workspace, runner: Runner): Promise<MapView> {
  const { map, crawl } = await workspace.appMap();
  const { project, store } = runner;
  const webhookPath = project.config.mockPay?.webhookPath;

  const routes = map.routes.map((r): MapRoute => {
    const lines: MapRoute["effects"] = [];
    const reads = new Set<string>();
    const writes = new Set<string>();
    const services = new Set<string>();
    // Worded as `windtunnel map` words them: reads by table, writes as a short statement.
    const visit = (effects: Effect[], tx: boolean, shown: boolean, keyPassed: boolean) => {
      for (const e of effects) {
        if (e.kind === "tx") visit(e.effects, true, shown, keyPassed);
        else if (e.kind === "call") {
          // An auth check shows as its name; what it reads stays behind it.
          if (e.auth && shown) lines.push({ kind: "auth", text: e.name, tx });
          visit(e.effects, tx, shown && !e.auth, keyPassed || e.keyArg);
        } else if (e.kind === "fetch") {
          services.add(`${e.method} ${e.url}`);
          const key = e.idempotencyKey === "always" || (e.idempotencyKey === "optional" && keyPassed);
          const note = e.method === "GET" ? "" : key ? " · idempotency key sent" : " · no idempotency key";
          if (shown) lines.push({ kind: "call", text: `${e.method} ${e.url}${note}`, tx });
        } else {
          for (const t of e.tables) (e.op === "SELECT" ? reads : writes).add(bare(t));
          if (!shown) continue;
          const conflict = /\bON CONFLICT\b.*$/i.exec(e.text)?.[0];
          const text =
            e.op === "SELECT" ? `${e.tables.map(bare).join(", ")}${e.forUpdate ? " FOR UPDATE" : ""}`
            : e.op === "INSERT" && e.text.startsWith("INSERT") ? `INSERT ${bare(e.tables[0]!)}${conflict ? ` ${conflict}` : ""}`
            : e.text.length > 120 ? `${e.text.slice(0, 117)}…`
            : e.text;
          lines.push({ kind: e.op === "SELECT" ? "read" : "write", text, tx });
        }
      }
    };
    visit(r.effects, false, true, false);
    return {
      key: `${r.method} ${r.path}`,
      method: r.method,
      path: r.path,
      file: r.file,
      ...(r.comment ? { comment: r.comment } : {}),
      flags: r.flags,
      notes: r.notes,
      reads: [...reads].filter((t) => !writes.has(t)),
      writes: [...writes],
      services: [...services],
      effects: lines,
      webhook: /webhook/i.test(r.path) || r.path === webhookPath,
    };
  });

  const routeFor = matcher(routes, (r) => (r.path.startsWith("/") ? `${r.method === "ANY" ? "*" : r.method} ${r.path}` : undefined));
  const pageFor = matcher(
    map.pages.filter((p) => p.kind === "page"),
    (p) => `GET ${p.path}`,
  );

  const pages = map.pages.map((p): MapPage => {
    const calls = p.ui.requests.flatMap((q) => routeFor(q.method, example(q.url))?.key ?? []);
    const visits =
      p.kind === "page"
        ? (crawl?.pages ?? [])
            .filter((c) => pageFor("GET", c.url.split("?")[0]!)?.path === p.path)
            .map((c) => ({ as: c.as, status: c.status, ...(c.final !== c.url ? { final: c.final } : {}) }))
        : [];
    return {
      path: p.path,
      file: p.file,
      layout: p.kind === "layout",
      login: p.ui.redirects.some((r) => /login|signin/i.test(r)),
      buttons: p.ui.buttons,
      fields: p.ui.fields,
      texts: p.ui.texts,
      calls: unique(calls),
      visits,
    };
  });

  const all = await loadExperiments(project).catch(() => [] as Experiment[]);
  const newest = new Map<string, { id: string; outcome: string; headline: string; startedAt: string }>();
  for (const r of await listRuns(store, 300)) {
    if (r.outcome !== "running" && r.outcome !== "stopped" && !newest.has(r.experiment)) newest.set(r.experiment, r);
  }

  const experiments: MapExperiment[] = [];
  for (const e of all.sort((a, b) => a.id.localeCompare(b.id))) {
    const entry = newest.get(e.id);
    const dir = entry && join(store.dir, entry.id);
    const result = dir ? await readJson<ExperimentResult>(join(dir, "run.json")) : undefined;
    const focus = result && (result.reps.find((r) => r.outcome === "broken") ?? result.reps.find((r) => r.outcome === "error") ?? result.reps[0]);
    let steps: MapExperiment["steps"] = [];
    let tables: string[] = [];
    if (dir && focus) {
      const repDir = store.repDir(dir, focus.rep);
      const requests = (await readJson<RequestRecord[]>(join(repDir, "requests.json"))) ?? [];
      const detail = await readJson<{ webhooks?: Webhook[] }>(join(repDir, "result.json"));
      const diff = await readJson<{ tables: Record<string, unknown> }>(join(repDir, "db-diff.json"));
      steps = stepsOf(requests, detail?.webhooks ?? [], webhookPath, (m, p) => routeFor(m, p)?.key, (p) => pageFor("GET", p)?.path);
      tables = Object.keys(diff?.tables ?? {}).map(bare);
    }
    const touched = result?.touched ?? [];
    const pagesHit = touched.flatMap((t) => {
      const [method, path] = t.split(" ");
      return method === "GET" ? (pageFor(method, path!)?.path ?? []) : [];
    });
    const routesHit = touched.flatMap((t) => {
      const [method, path] = t.split(" ");
      return routeFor(method!, path!)?.key ?? [];
    });
    experiments.push({
      id: e.id,
      ...(e.description ? { description: e.description } : {}),
      users: e.users ?? [],
      pressure: pressureOf(e, steps, routes.filter((r) => r.webhook).map((r) => r.key)),
      ...(entry && result && focus
        ? {
            run: {
              id: entry.id,
              outcome: entry.outcome,
              headline: entry.headline,
              startedAt: entry.startedAt,
              rep: focus.rep,
              reps: result.reps.length,
              broken: unique(result.reps.flatMap((r) => r.broken)),
            },
          }
        : {}),
      pages: unique([...pagesHit, ...steps.flatMap((s) => s.pages)]),
      routes: unique([...routesHit, ...steps.flatMap((s) => s.calls.map((c) => c.route))]),
      tables,
      steps,
    });
  }

  const tables = unique(routes.flatMap((r) => [...r.writes, ...r.reads]));
  return {
    framework: map.framework,
    pages,
    routes,
    tables,
    services: unique(routes.flatMap((r) => r.services)),
    experiments,
    ...(crawl ? { crawl: { at: crawl.at, stale: crawl.stale } } : {}),
  };
}

interface Webhook {
  path?: string;
  deliveries: { at: string; status: number | null; ms?: number }[];
}

/**
 * A run's steps in the order they began: the pages each opened and the routes it called, how many
 * times, from how many tabs, and whether two were in the app at once. Webhook deliveries go last.
 */
function stepsOf(
  requests: RequestRecord[],
  webhooks: Webhook[],
  webhookPath: string | undefined,
  route: (method: string, path: string) => string | undefined,
  page: (path: string) => string | undefined,
): MapExperiment["steps"] {
  const lastStep = new Map<string, string>();
  let latest = "";
  type Seen = { tab: string; start: number; end: number; failed: boolean };
  const steps = new Map<string, { pages: string[]; calls: Map<string, Seen[]> }>();
  for (const r of [...requests].sort((a, b) => a.start - b.start)) {
    const path = r.url.split("?")[0]!;
    const rsc = /[?&]_rsc=/.test(r.url);
    // Between steps (a page still loading after a click): the tab's step before, or for a tab
    // just opened, the step that opened it.
    const name = r.step ?? lastStep.get(r.tab) ?? latest;
    lastStep.set(r.tab, name);
    latest = name;
    const step = steps.get(name) ?? { pages: [] as string[], calls: new Map<string, Seen[]>() };
    if (r.method === "GET" && r.type === "document") {
      const p = page(path);
      if (!p) continue;
      if (!step.pages.includes(p)) step.pages.push(p);
    } else if (!rsc && (r.type === "fetch" || r.type === "xhr" || r.method !== "GET")) {
      const key = route(r.method, path);
      if (!key) continue;
      const call = step.calls.get(key) ?? [];
      call.push({ tab: r.tab, start: r.start, end: r.end ?? Infinity, failed: !!r.failure || (r.status ?? 0) >= 400 });
      step.calls.set(key, call);
    } else continue;
    steps.set(name, step);
  }
  const out = [...steps].map(([name, s]) => ({
    name: name || "between steps",
    pages: s.pages,
    calls: [...s.calls].map(([key, seen]) => callOf(key, seen)),
  }));
  const deliveries = webhooks.flatMap((w) =>
    w.deliveries.map((d) => {
      const start = Date.parse(d.at);
      return { path: w.path ?? webhookPath, tab: "provider", start, end: start + (d.ms ?? 0), failed: d.status === null || d.status >= 400 };
    }),
  );
  const key = deliveries[0]?.path && route("POST", deliveries[0].path);
  if (key) out.push({ name: "payment webhook", pages: [], calls: [{ ...callOf(key, deliveries), tabs: 1 }] });
  return out;
}

function callOf(route: string, list: { tab: string; start: number; end: number; failed: boolean }[]): MapCall {
  const together = list.some((a, i) => list.some((b, j) => j > i && (a.tab !== b.tab || a.tab === "provider") && a.start < b.end && b.start < a.end));
  return { route, count: list.length, tabs: new Set(list.map((x) => x.tab)).size, together, failed: list.filter((x) => x.failed).length };
}

/** Where an experiment pushes, in a few words, and the routes that lands on in its newest run. */
function pressureOf(e: Experiment, steps: MapExperiment["steps"], webhookRoutes: string[]): MapExperiment["pressure"] {
  const called = (step?: string) => unique(steps.filter((s) => !step || s.name === step).flatMap((s) => s.calls.map((c) => c.route)));
  // The routes a request pattern (`POST /api/**`) caught, in the step if it names one.
  const caught = (request: string, step?: string) => {
    let pattern: RequestPattern;
    try {
      pattern = parseRequestPattern(request);
    } catch {
      return [];
    }
    return called(step).filter((key) => {
      const [method, path] = key.split(" ");
      return matchesRequest(pattern, method!, `http://x${example(path!)}`);
    });
  };
  // A step's route: the first write it sends, else whatever it calls.
  const inStep = (step: string) => {
    const calls = called(step);
    const first = calls.find((c) => !c.startsWith("GET ")) ?? calls[0];
    return first ? [first] : [];
  };
  const out: MapExperiment["pressure"] = [];
  if (e.race) out.push({ what: "at once", routes: caught(e.race.request, e.race.step), ...(e.race.step ? { step: e.race.step } : {}) });
  for (const p of e.perturb) {
    const what =
      p.do === "delay" ? `slowed ${duration(p.ms)}`
      : p.do === "fail" ? `answered ${p.status}`
      : p.do === "lose-response" ? "response lost"
      : p.do === "duplicate" ? "sent twice"
      : p.do === "replay-as" ? `replayed as ${p.user}`
      : p.do === "double-submit" ? "double submit"
      : p.do === "repeat" ? (p.times > 1 ? `repeated ×${p.times}` : "repeated")
      : p.do === "refresh" ? `refreshed ${p.when}`
      : p.do === "back-resubmit" ? "back and resubmit"
      : p.do === "expire-session" ? "session expired"
      : p.do === "advance-clock" ? `clock +${duration(p.by)}`
      : p.do === "second-tab" ? "second tab"
      : "database edited";
    out.push({ what, routes: "request" in p ? caught(p.request, p.step) : inStep(p.step), ...(p.step ? { step: p.step } : {}) });
  }
  const w = e.webhooks;
  if (w) {
    const what =
      w.times > 1 ? (w.times === 2 ? "webhook twice" : `webhook ×${w.times}`)
      : w.timing === "early" ? "webhook early"
      : w.order === "reverse" ? "webhooks out of order"
      : w.timing === "late" ? "webhook late"
      : w.delay !== undefined ? "webhook delayed"
      : undefined;
    if (what) out.push({ what, routes: webhookRoutes });
  }
  return out;
}

/** Finds the item a request is for, literal paths before parameterised ones (`/orders/new` before `/orders/:id`). */
function matcher<T>(items: T[], patternOf: (item: T) => string | undefined): (method: string, path: string) => T | undefined {
  const list: { item: T; pattern: RequestPattern }[] = [];
  for (const item of items) {
    const text = patternOf(item);
    if (!text) continue;
    try {
      list.push({ item, pattern: parseRequestPattern(text) });
    } catch {
      // A path the pattern syntax can't express: left off the picture.
    }
  }
  list.sort((a, b) => a.pattern.text.split(/[:*]/).length - b.pattern.text.split(/[:*]/).length);
  return (method, path) => {
    if (!path?.startsWith("/")) return undefined;
    return list.find((x) => matchesRequest(x.pattern, method, `http://x${path}`))?.item;
  };
}

/** A path pattern (`/api/products/*`, `/orders/:id`) as a request path that would match it. */
function example(path: string): string {
  return path.replace(/\*\*?|:\w+/g, "1");
}

function duration(ms: number): string {
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function bare(table: string): string {
  return table.replace(/^public\./, "");
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

async function readJson<T>(path: string): Promise<T | undefined> {
  return JSON.parse(await readFile(path, "utf8").catch(() => "null")) ?? undefined;
}

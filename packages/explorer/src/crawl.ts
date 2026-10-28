import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import axe from "axe-core";
import {
  changedFiles,
  type CodeVersionSpec,
  CONTROL_ROLES,
  describeElement,
  type FlowContext,
  findFlowFile,
  formatSnapshot,
  LOGIN_FLOW,
  loadFlow,
  matchesRequest,
  type PageSnapshot,
  parseRequestPattern,
  type Project,
  type Runner,
  snapshotPage,
  type TestUser,
} from "@windtunnel/core";
import { chromium, type ConsoleMessage, type Page, type Request } from "playwright";
import { findNextRoutes } from "./routes.ts";

export const CRAWL_DIR = join("cache", "crawl");

export interface CrawledPage {
  /** Path and query as visited. */
  url: string;
  /** Where it ended up after redirects. */
  final: string;
  /** `anonymous` or a test user. */
  as: string;
  /** The app's route for it, e.g. `/products/:id`. */
  route?: string;
  status: number;
  /** Until the load event. */
  ms: number;
  snapshot: PageSnapshot;
}

export interface SweepFinding {
  kind: "console" | "request" | "link" | "a11y" | "slow";
  /** high: users see it break · medium: likely a problem · low: worth a look. */
  severity: "high" | "medium" | "low";
  summary: string;
  /** Pages it happened on, as `/path (user)`. */
  pages: string[];
  count: number;
  detail?: string;
}

export interface CrawlResult {
  version: { id: string; label: string; tree?: string };
  at: string;
  ms: number;
  as: string[];
  pages: CrawledPage[];
  sweep: SweepFinding[];
  notes: string[];
}

/** Per visit: what went wrong while it loaded. */
interface VisitIssues {
  console: string[];
  failed: { method: string; path: string; status?: number; error?: string; ms: number }[];
  slow: { method: string; path: string; ms: number }[];
}

const SKIP_LINK = /log-?out|sign-?out|logoff/i;
const ASSET = /\.(pdf|zip|png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|woff2?|ttf|txt|xml|csv)$/i;
const PER_ROUTE = 2;
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Rules-mode crawl of a running copy of the app: follows links (never submits forms or presses
 * buttons, and runs on its own database copy anyway) as an anonymous visitor and as test users,
 * snapshots each page's controls, and sweeps for console errors, failed requests, broken links,
 * accessibility problems and slow pages. No model involved.
 */
export async function crawl(
  runner: Runner,
  options: { version?: CodeVersionSpec; users?: string[]; maxPages?: number; onProgress?: (message: string) => void } = {},
): Promise<CrawlResult> {
  const project = runner.project;
  const settings = project.config.crawl;
  const started = Date.now();
  const configured = Object.keys(project.config.users);
  const users = options.users ?? settings.users ?? configured.slice(0, 1);
  for (const u of users) if (!project.config.users[u]) throw new Error(`crawl: unknown user "${u}" (config users: ${configured.join(", ") || "none"})`);
  const maxPages = options.maxPages ?? settings.maxPages;
  const skip = settings.skip.map((s) => new RegExp(s));
  const { routes } = await findNextRoutes(project.root);
  // Literal paths before parameterised ones: /orders/new before /orders/:id.
  const patterns = routes
    .filter((r) => r.kind === "page" || r.kind === "app" || r.kind === "pages-api")
    .map((r) => ({ r, p: parseRequestPattern(`* ${r.path}`) }))
    .sort((a, b) => a.p.text.split(/[:*]/).length - b.p.text.split(/[:*]/).length);
  const routeOf = (path: string) => patterns.find(({ p }) => matchesRequest(p, "GET", `http://x${path}`))?.r;
  const starts = ["/", ...routes.filter((r) => r.kind === "page" && !/[:*]/.test(r.path) && r.path !== "/").map((r) => r.path)];

  const branch = await runner.branches.create(options.version ?? {}, { logDir: join(project.stateDir, "logs", "crawl") });
  const browser = await chromium.launch();
  const login = (await findFlowFile(project.stateDir, LOGIN_FLOW)) ? await loadFlow(project.stateDir, LOGIN_FLOW) : undefined;
  const testUsers: Record<string, TestUser> = Object.fromEntries(Object.entries(project.config.users).map(([name, u]) => [name, { name, ...u }]));
  const pages: CrawledPage[] = [];
  const notes: string[] = [];
  const findings = new Map<string, SweepFinding>();
  const note = (key: string, f: Omit<SweepFinding, "pages" | "count">, where: string) => {
    const existing = findings.get(key);
    if (existing) {
      existing.count++;
      if (!existing.pages.includes(where)) existing.pages.push(where);
    } else findings.set(key, { ...f, pages: [where], count: 1 });
  };

  const crawlAs = async (as: string) => {
    const context = await browser.newContext({
      baseURL: branch.baseUrl,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(10_000);
    try {
      const page = await context.newPage();
      if (as !== "anonymous") {
        if (!login) {
          notes.push(`not crawled as ${as}: no .windtunnel/flows/login.ts`);
          return;
        }
        const user = testUsers[as]!;
        const ctx: FlowContext = { page, step: (_n, action) => action(), login: async () => undefined, user, users: testUsers, params: {}, baseUrl: branch.baseUrl, tab: as, clock: page.clock };
        try {
          await login.flow.run(ctx);
        } catch (err) {
          notes.push(`not crawled as ${as}: logging in failed (${(err as Error).message.split("\n")[0]})`);
          return;
        }
      }
      const origin = new URL(branch.baseUrl).origin;
      const queue = [...starts];
      const queued = new Set(queue);
      const perRoute = new Map<string, number>();
      const axed = new Set<string>();
      const linkedFrom = new Map<string, Set<string>>();
      const visited = new Set<string>();
      let count = 0;
      while (queue.length && count < maxPages) {
        const url = queue.shift()!;
        const route = routeOf(url.split("?")[0]!);
        const key = route?.path ?? url;
        if ((perRoute.get(key) ?? 0) >= PER_ROUTE) continue;
        perRoute.set(key, (perRoute.get(key) ?? 0) + 1);
        count++;
        const issues: VisitIssues = { console: [], failed: [], slow: [] };
        const stop = watch(page, origin, project.config.crawl.slowRequestMs, issues);
        const t0 = Date.now();
        const response = await page.goto(url, { waitUntil: "load" }).catch((err: Error) => {
          issues.console.push(`navigation failed: ${err.message.split("\n")[0]}`);
          return null;
        });
        const ms = Date.now() - t0;
        await quiet(page);
        stop();
        const final = pathOf(page.url());
        const where = `${url}${as === "anonymous" ? "" : ` (${as})`}`;
        const status = response?.status() ?? 0;
        visited.add(url);
        options.onProgress?.(`crawl ${as}: ${url} ${status} ${ms} ms`);
        // A 4xx on a route visited directly (not linked for this user) is usually access control working.
        const from = [...(linkedFrom.get(url) ?? [])];
        if (status >= 500 || (status >= 400 && from.length)) {
          note(`status ${status} ${key}`, { kind: from.length ? "link" : "request", severity: status >= 500 ? "high" : "medium", summary: `${url} answers ${status}${from.length ? ` (linked from ${from.slice(0, 3).join(", ")})` : ""}` }, where);
        }
        for (const text of issues.console) note(`console ${text.slice(0, 120)}`, { kind: "console", severity: "high", summary: `console: ${text.slice(0, 200)}` }, where);
        for (const f of issues.failed) {
          const path = routeOf(f.path)?.path ?? f.path;
          note(`failed ${f.method} ${path} ${f.status ?? f.error}`, { kind: "request", severity: (f.status ?? 500) >= 500 ? "high" : "medium", summary: `${f.method} ${path} → ${f.status ?? f.error}` }, where);
        }
        for (const s of issues.slow) {
          const path = routeOf(s.path)?.path ?? s.path;
          note(`slow ${s.method} ${path}`, { kind: "slow", severity: "low", summary: `${s.method} ${path} took ${s.ms} ms (limit ${project.config.crawl.slowRequestMs})` }, where);
        }
        if (ms > project.config.crawl.slowPageMs) note(`slow page ${key}`, { kind: "slow", severity: "low", summary: `${key} took ${ms} ms to load (limit ${project.config.crawl.slowPageMs})` }, where);
        if (final !== url && visited.has(final)) continue;
        visited.add(final);

        const snapshot = await snapshotPage(page);
        if (snapshot) pages.push({ url, final, as, ...(route ? { route: route.path } : {}), status, ms, snapshot });
        if (!axed.has(key) && status < 400) {
          axed.add(key);
          for (const v of await accessibility(page)) {
            note(`a11y ${v.id}`, { kind: "a11y", severity: v.impact === "critical" || v.impact === "serious" ? "medium" : "low", summary: `${v.id} (${v.impact}): ${v.help}`, detail: `${v.nodes} element(s), e.g. ${v.target}` }, where);
          }
        }
        for (const href of await links(page)) {
          let target: URL;
          try {
            target = new URL(href, page.url());
          } catch {
            continue;
          }
          if (target.origin !== origin || !/^https?:$/.test(target.protocol)) continue;
          const path = target.pathname + target.search;
          if (!linkedFrom.has(path)) linkedFrom.set(path, new Set());
          linkedFrom.get(path)!.add(final);
          if (queued.has(path) || SKIP_LINK.test(path) || skip.some((r) => r.test(path)) || ASSET.test(target.pathname) || target.pathname.startsWith("/api/")) continue;
          queued.add(path);
          queue.push(path);
        }
      }
      if (queue.length) notes.push(`${as}: stopped at ${maxPages} pages (crawl.maxPages); ${queue.length} more queued`);
      // Links not visited (page limit, a route already seen twice, API and file links): checked without a browser.
      for (const [path, from] of linkedFrom) {
        if (visited.has(path) || SKIP_LINK.test(path) || skip.some((r) => r.test(path))) continue;
        const response = await context.request.get(path, { maxRedirects: 5, failOnStatusCode: false, timeout: 5_000 }).catch(() => undefined);
        const status = response?.status() ?? 0;
        if (status === 0 || status >= 400) {
          const where = [...from][0]! + (as === "anonymous" ? "" : ` (${as})`);
          note(`link ${path}`, { kind: "link", severity: status >= 500 || status === 0 ? "high" : "medium", summary: `link to ${path} answers ${status || "nothing"}` }, where);
        }
      }
    } finally {
      await context.close().catch(() => undefined);
    }
  };

  try {
    await Promise.all(["anonymous", ...users].map(crawlAs));
  } finally {
    await browser.close().catch(() => undefined);
    await branch.stop().catch(() => undefined);
  }
  const order = { high: 0, medium: 1, low: 2 };
  const result: CrawlResult = {
    version: { id: branch.version.id, label: branch.version.label, tree: branch.version.tree },
    at: new Date(started).toISOString(),
    ms: Date.now() - started,
    as: ["anonymous", ...users],
    pages,
    sweep: [...findings.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.pages.length - a.pages.length),
    notes,
  };
  const dir = join(project.stateDir, CRAWL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${result.version.id}.json`), `${JSON.stringify(result)}\n`);
  return result;
}

/**
 * The newest crawl, with `stale` set when files of the app changed since (Wind Tunnel's own
 * state and files outside the app don't count).
 */
export async function readCrawl(project: Project, current?: { id: string; tree?: string }): Promise<(CrawlResult & { stale: boolean }) | undefined> {
  const dir = join(project.stateDir, CRAWL_DIR);
  const exact = current && (await readFile(join(dir, `${current.id}.json`), "utf8").catch(() => undefined));
  if (exact) return { ...(JSON.parse(exact) as CrawlResult), stale: false };
  const all = await Promise.all(
    (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as CrawlResult),
  );
  const newest = all.sort((a, b) => b.at.localeCompare(a.at))[0];
  if (!newest) return undefined;
  if (!current?.tree || !newest.version.tree) return { ...newest, stale: !!current };
  const prefix = project.appSubdir ? `${project.appSubdir.split(sep).join("/")}/` : "";
  const changed = await changedFiles(project.repoRoot, newest.version.tree, current.tree).catch(() => undefined);
  const inApp = changed?.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).startsWith(".windtunnel/"));
  return { ...newest, stale: !inApp || inApp.length > 0 };
}

/** Records console errors, failed and slow same-origin requests while a page loads. */
function watch(page: Page, origin: string, slowMs: number, issues: VisitIssues): () => void {
  const started = new Map<object, number>();
  const onConsole = (msg: ConsoleMessage) => {
    // Failed loads show up as failed requests, with the URL.
    if (msg.type() === "error" && !/^Failed to load resource/.test(msg.text())) issues.console.push(msg.text().replace(/\s+/g, " "));
  };
  const onError = (err: Error) => issues.console.push(`uncaught ${err.name}: ${err.message.split("\n")[0]}`);
  const onRequest = (req: Request) => started.set(req, Date.now());
  const sameOrigin = (url: string) => {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  };
  const onFinished = (req: Request) => {
    if (!sameOrigin(req.url())) return;
    const ms = Date.now() - (started.get(req) ?? Date.now());
    void req.response().then((res) => {
      const status = res?.status() ?? 0;
      if (status >= 400 && req.resourceType() !== "document") issues.failed.push({ method: req.method(), path: pathOf(req.url()).split("?")[0]!, status, ms });
      else if (ms > slowMs && req.resourceType() !== "document") issues.slow.push({ method: req.method(), path: pathOf(req.url()).split("?")[0]!, ms });
    });
  };
  const onFailed = (req: Request) => {
    const error = req.failure()?.errorText ?? "failed";
    // Navigating away cancels requests: not a fault.
    if (!sameOrigin(req.url()) || /ERR_ABORTED|NS_BINDING_ABORTED/.test(error)) return;
    issues.failed.push({ method: req.method(), path: pathOf(req.url()).split("?")[0]!, error, ms: 0 });
  };
  page.on("console", onConsole);
  page.on("pageerror", onError);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onError);
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
}

/** Waits until no request has been in flight for 150 ms (at most 2 s). */
async function quiet(page: Page): Promise<void> {
  let inflight = 0;
  let last = Date.now();
  const up = () => {
    inflight++;
  };
  const down = () => {
    inflight = Math.max(0, inflight - 1);
    last = Date.now();
  };
  page.on("request", up);
  page.on("requestfinished", down);
  page.on("requestfailed", down);
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (inflight > 0 || Date.now() - last < 150)) await new Promise((r) => setTimeout(r, 50));
  page.off("request", up);
  page.off("requestfinished", down);
  page.off("requestfailed", down);
}

async function links(page: Page): Promise<string[]> {
  // A string, as the project has no DOM types.
  return page.evaluate<string[]>(`[...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "")`).catch(() => []);
}

async function accessibility(page: Page): Promise<{ id: string; impact: string; help: string; nodes: number; target: string }[]> {
  try {
    await page.addScriptTag({ content: axe.source });
    const options = JSON.stringify({ runOnly: { type: "tag", values: AXE_TAGS }, resultTypes: ["violations"] });
    return await page.evaluate(
      `axe.run(document, ${options}).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact ?? "minor", help: v.help, nodes: v.nodes.length, target: String(v.nodes[0]?.target?.[0] ?? "") })))`,
    );
  } catch {
    return [];
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

// ---- Text ----

/** The sweep's findings, one line each. */
export function formatSweep(findings: SweepFinding[], max = 12): string {
  if (findings.length === 0) return "free sweep: nothing found (console, requests, links, accessibility, speed)";
  const lines = [`free sweep: ${findings.length} finding(s)`];
  for (const f of findings.slice(0, max)) {
    const pages = f.pages.length > 2 ? `${f.pages.slice(0, 2).join(", ")} +${f.pages.length - 2}` : f.pages.join(", ");
    lines.push(`  ${f.severity.padEnd(6)} ${f.kind.padEnd(7)} ${f.summary}  [${pages}]${f.detail ? `  ${f.detail}` : ""}`);
  }
  if (findings.length > max) lines.push(`  … ${findings.length - max} more (windtunnel_evidence handle=sweep)`);
  return lines.join("\n");
}

/** For the app map: pages as each user saw them, with the controls a flow would use. */
export function formatCrawl(c: CrawlResult & { stale?: boolean }, maxChars = 4_000, focus?: string): string {
  const stale = c.stale ? " — the app's code changed since; crawl again for fresh names" : "";
  const lines = [`Live crawl (version ${c.version.id}${stale}, ${c.pages.length} pages as ${c.as.join(", ")}, ${(c.ms / 1000).toFixed(1)} s): controls as getByRole sees them`];
  const f = focus?.toLowerCase();
  for (const p of c.pages.filter((p) => !f || p.url.toLowerCase().includes(f) || p.route?.toLowerCase().includes(f))) {
    const controls = p.snapshot.elements.filter((e) => (CONTROL_ROLES.has(e.role) && e.role !== "link") || e.clickable);
    const counts = new Map<string, number>();
    for (const e of controls) counts.set(describeElement(e), (counts.get(describeElement(e)) ?? 0) + 1);
    const shown = [...counts].slice(0, 10).map(([d, n]) => (n > 1 ? `${d} ×${n}` : d));
    const linksOut = p.snapshot.elements.filter((e) => e.role === "link").length;
    const moved = p.final !== p.url ? ` → ${p.final}` : "";
    lines.push(`${p.url}${moved} (${p.as}, ${p.status})${shown.length ? `  ${shown.join(" · ")}` : ""}${counts.size > 10 ? ` · +${counts.size - 10}` : ""}${linksOut ? ` · ${linksOut} links` : ""}`);
  }
  lines.push(formatSweep(c.sweep, 6));
  for (const n of c.notes) lines.push(`note: ${n}`);
  lines.push(`Full page snapshots with locators: windtunnel_evidence handle=crawl:<path>`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut; windtunnel_evidence handle=crawl lists every page)` : text;
}

/** Drill-down: `crawl` (pages), `crawl:/path` (one page with locators), `sweep` (every finding). */
export function crawlDrillDown(c: CrawlResult, part: string): string {
  if (part === "sweep") return formatSweep(c.sweep, 200);
  if (part === "crawl") return formatCrawl(c, 20_000);
  const path = part.slice("crawl:".length);
  const matches = c.pages.filter((p) => p.url === path || p.final === path || p.route === path);
  if (matches.length === 0) return `no crawled page ${path}; crawled: ${[...new Set(c.pages.map((p) => p.url))].join(", ")}`;
  return matches.map((p) => `${p.as}: ${formatSnapshot(p.snapshot, { max: 120 })}`).join("\n\n");
}

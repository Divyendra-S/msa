import { randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareLanes,
  ConfigError,
  type LaneRef,
  listRuns,
  listUsage,
  repView,
  type Runner,
  runDetail,
  VIEWER_FILE,
  type ViewerState,
} from "@windtunnel/core";
import { Workspace } from "@windtunnel/mcp";
import { HuntError, type HuntEvent, type HuntInfo, HuntManager } from "./hunt.ts";
import { StoreWatcher } from "./watch.ts";

export const DEFAULT_PORT = 4477;
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The built UI: dist/ of this package, or ui/ in the published CLI (whose code is in dist/). */
export const DIST_DIR = join(PACKAGE_DIR, import.meta.url.endsWith(".ts") ? "dist" : "ui");
const MAX_LANES = 8;
const MAX_BODY = 64 * 1024;

export interface ViewerOptions {
  /** The app's folder, or a folder above or below it (as for the MCP server). */
  cwd: string;
  /** Default 4477, or the next free port after it; 0 for any. */
  port?: number;
  /** Built UI to serve (default: this package's dist/). */
  distDir?: string;
  /** Environment for the hunt (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

export interface Viewer {
  /** `http://127.0.0.1:<port>` */
  url: string;
  /** Opens the viewer: sets the session cookie, then shows the runs. */
  openUrl: string;
  port: number;
  token: string;
  root: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<unknown>;

/**
 * The local API and web viewer: runs, aligned timelines, first divergence, trace chain, database
 * changes, rule results and usage, plus the Run hunt button. Listens on 127.0.0.1 only; every API
 * call needs the session cookie (or token header) and a local Host, so other sites can't use it.
 */
export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  const workspace = new Workspace(options.cwd);
  const runner = await workspace.open();
  const { project } = runner;
  const token = randomBytes(24).toString("hex");
  const distDir = options.distDir ?? DIST_DIR;
  const hunts = new HuntManager(project.stateDir, project.root, project.config.hunt.command, options.env ?? process.env);
  const watcher = new StoreWatcher(runner.store, project.stateDir);
  const clients = new Set<ServerResponse>();
  let port = 0;
  const cookie = () => `wt_viewer_${port}`;

  const evidenceOptions = async () => ({
    rules: await workspace.rules(),
    handlerFor: await cachedResolver(workspace),
    source: project,
  });

  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
    { method: "GET", pattern: /^\/api\/status$/, handler: async () => status(workspace, runner, hunts) },
    {
      method: "GET",
      pattern: /^\/api\/runs$/,
      handler: async (_q, _s, _p, url) => listRuns(runner.store, clamp(Number(url.searchParams.get("limit") ?? 100), 1, 300)),
    },
    { method: "GET", pattern: /^\/api\/runs\/([\w-]+)$/, handler: async (_q, _s, [id]) => runDetail(runner.store, id!) },
    {
      method: "GET",
      pattern: /^\/api\/runs\/([\w-]+)\/reps\/(\d+)$/,
      handler: async (_q, _s, [id, n]) => repView(runner.store, id!, Number(n), await evidenceOptions()),
    },
    {
      method: "GET",
      pattern: /^\/api\/runs\/([\w-]+)\/reps\/(\d+)\/screens\/([\w-]+\.jpg)$/,
      handler: async (_q, res, [id, n, file]) => {
        const path = join(runner.store.repDir(join(runner.store.dir, id!), Number(n)), "screens", file!);
        await sendFile(res, path, "image/jpeg");
        return SENT;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/compare$/,
      handler: async (_q, _s, _p, url) => {
        const lanes = (url.searchParams.get("lanes") ?? "").split(",").filter(Boolean).map(parseLane);
        if (lanes.length === 0) throw new HttpError(400, "lanes=<run>/<n>,… is required");
        if (lanes.length > MAX_LANES) throw new HttpError(400, `at most ${MAX_LANES} lanes`);
        return compareLanes(runner.store, lanes);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/usage$/,
      handler: async () => ({ budget: project.config.budget, jobs: await listUsage(project.stateDir, 30) }),
    },
    { method: "GET", pattern: /^\/api\/decisions$/, handler: async () => (await workspace.decisions()).open() },
    { method: "GET", pattern: /^\/api\/hunts$/, handler: async () => hunts.list(30) },
    {
      method: "GET",
      pattern: /^\/api\/hunts\/([\w-]+)$/,
      handler: async (_q, _s, [id]) => (await hunts.get(id!)) ?? notFound(`no hunt ${id}`),
    },
    {
      method: "POST",
      pattern: /^\/api\/hunts$/,
      handler: async (req) => {
        const body = (await readBody(req)) as { prompt?: unknown };
        if (typeof body.prompt !== "string") throw new HttpError(400, "prompt (a string) is required");
        return hunts.start(body.prompt);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/hunts\/([\w-]+)\/stop$/,
      handler: async (_q, _s, [id]) => ({ stopping: hunts.stop(id!) }),
    },
    {
      method: "GET",
      pattern: /^\/api\/events$/,
      handler: async (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("retry: 2000\n\n");
        clients.add(res);
        const unwatch = watcher.subscribe((change) => send(res, change));
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(beat);
          unwatch();
          clients.delete(res);
        });
        return SENT;
      },
    },
  ];

  const unsubscribe = hunts.subscribe((id, event?: HuntEvent, info?: HuntInfo) => {
    const message = event ? { type: "hunt-event", id, event } : { type: "hunt", id, info };
    for (const c of clients) send(c, message);
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => fail(res, err));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 must not reach the API.
    if (!localHost(req.headers.host, port)) throw new HttpError(403, "the viewer only answers on 127.0.0.1 and localhost");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
      const given = url.searchParams.get("token");
      if (url.pathname === "/" && given) {
        if (!same(given, token)) throw new HttpError(403, "this viewer link is from an earlier session: run windtunnel view again");
        res.writeHead(302, {
          "set-cookie": `${cookie()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          location: "/",
        });
        res.end();
        return;
      }
      await serveStatic(res, distDir, url.pathname);
      return;
    }

    if (!authorized(req, token, cookie())) throw new HttpError(401, "open the viewer with the link windtunnel view printed");
    if (req.method === "POST") {
      // Same-origin pages only, with a JSON body (a plain form post can't send one).
      const origin = req.headers.origin;
      if (origin && !localOrigin(origin, port)) throw new HttpError(403, "cross-origin request");
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send JSON");
    }
    const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) throw new HttpError(404, `no ${req.method} ${url.pathname}`);
    const params = route.pattern.exec(url.pathname)!.slice(1);
    const result = await route.handler(req, res, params, url);
    if (result === SENT) return;
    const body = JSON.stringify(result);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  port = await listen(server, options.port ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}`;
  const state: ViewerState = { url, port, pid: process.pid, token, startedAt: new Date().toISOString() };
  const stateFile = join(project.stateDir, VIEWER_FILE);
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  return {
    url,
    openUrl: `${url}/?token=${token}`,
    port,
    token,
    root: project.root,
    async close() {
      unsubscribe();
      watcher.close();
      for (const c of clients) c.end();
      await hunts.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      // Only our own state file: another viewer may have started since.
      const current = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}")) as Partial<ViewerState>;
      if (current.pid === process.pid && current.port === port) await rm(stateFile, { force: true });
      await workspace.close();
    },
  };
}

const SENT = Symbol("sent");

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function notFound(message: string): never {
  throw new HttpError(404, message);
}

async function status(workspace: Workspace, runner: Runner, hunts: HuntManager) {
  const { project } = runner;
  const hunt = await hunts.availability();
  return {
    project: { name: basename(project.root), root: project.root, repoRoot: project.repoRoot, appSubdir: project.appSubdir },
    hunt: { ...hunt, skill: project.config.hunt.skill, running: hunts.running() ?? null },
    decider: (await workspace.decider()).level,
    budget: project.config.budget,
    users: Object.keys(project.config.users),
  };
}

/** The app map's request → handler lookup, rebuilt at most every 30 s (it parses the code). */
const resolvers = new WeakMap<Workspace, { at: number; resolver: Promise<((m: string, p: string) => string | undefined) | undefined> }>();
function cachedResolver(workspace: Workspace): Promise<((m: string, p: string) => string | undefined) | undefined> {
  const cached = resolvers.get(workspace);
  if (cached && Date.now() - cached.at < 30_000) return cached.resolver;
  const resolver = workspace.handlerResolver().catch(() => undefined);
  resolvers.set(workspace, { at: Date.now(), resolver });
  return resolver;
}

function parseLane(text: string): LaneRef {
  const m = /^([\w-]+)\/(\d+)$/.exec(text);
  if (!m) throw new HttpError(400, `lane "${text}": expected <run>/<n>`);
  return { run: m[1]!, rep: Number(m[2]) };
}

function send(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function fail(res: ServerResponse, err: unknown): void {
  const status =
    err instanceof HttpError || err instanceof HuntError
      ? err.status
      : err instanceof ConfigError || /^(no run|bad run id|run .* has no)/.test((err as Error)?.message ?? "")
        ? 404
        : 500;
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: (err as Error)?.message ?? String(err) }));
}

function localHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function localOrigin(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}` || origin === `http://[::1]:${port}`;
}

function authorized(req: IncomingMessage, token: string, name: string): boolean {
  const header = req.headers["x-windtunnel-token"];
  if (typeof header === "string" && same(header, token)) return true;
  const cookies = (req.headers.cookie ?? "").split(";").map((c) => c.trim());
  const value = cookies.find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  return !!value && same(value, token);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

async function serveStatic(res: ServerResponse, distDir: string, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    throw new HttpError(404, "not found");
  }
  const path = resolve(distDir, rel);
  if (!path.startsWith(resolve(distDir) + sep)) throw new HttpError(404, "not found");
  if (rel === "index.html" && !(await stat(path).catch(() => undefined))) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Wind Tunnel</title><body style="font:15px system-ui;margin:3rem">
<h1>The viewer isn't built</h1><p>Run <code>pnpm viewer:build</code> in the Wind Tunnel repository, then reload. The API is up at <code>/api/status</code>.</p>`);
    return;
  }
  const type = TYPES[extname(path)] ?? "application/octet-stream";
  // Hashed asset names never change; the page itself is always fetched fresh.
  res.setHeader("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store");
  if (rel === "index.html") {
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
  await sendFile(res, path, type);
}

async function sendFile(res: ServerResponse, path: string, type: string): Promise<void> {
  const s = await stat(path).catch(() => undefined);
  if (!s?.isFile()) throw new HttpError(404, "not found");
  res.writeHead(200, { "content-type": type, "content-length": s.size });
  await new Promise<void>((resolveDone, reject) => {
    createReadStream(path).on("error", reject).on("end", resolveDone).pipe(res);
  });
}

/** Listens on 127.0.0.1: the given port, else the next free one of the ten after it (0: any). */
async function listen(server: Server, first: number): Promise<number> {
  const tries = first === 0 ? [0] : Array.from({ length: 10 }, (_, i) => first + i);
  for (const port of tries) {
    const ok = await new Promise<boolean>((done, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") done(false);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        done(true);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (ok) return (server.address() as AddressInfo).port;
  }
  throw new Error(`ports ${first}–${first + 9} are all in use: pass --port`);
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : max;
}

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MockPay, type Tenant } from "@windtunnel/mock-pay";
import { expandVars } from "../config.ts";
import { type Database, databaseEnv, openSqlite } from "../database.ts";
import { Service, sh } from "../exec.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { exists, openProject, type Project } from "../project.ts";
import { HttpProxy } from "../runner/proxy.ts";
import { type CodeVersion, type CodeVersionSpec, CodeVersions, type PreparedVersion } from "./code-versions.ts";
import { PgServer } from "./postgres.ts";
import { type SqlLog, SqlProxy } from "./sql-log.ts";

export interface CreateBranchOptions {
  /** Keep the run database after stop() for inspection. */
  keepDatabase?: boolean;
  /** Where the app log goes (default `.windtunnel/logs/branches/<id>`). */
  logDir?: string;
  /** Runs after the database copy exists and before the app starts. */
  beforeStart?: (database: Database | undefined) => Promise<void>;
  /** Put an HTTP proxy in front of the app: clients and $BASE_URL go through it (the seam for any client). */
  proxy?: boolean;
}

export interface BranchInfo {
  id: string;
  version: CodeVersion;
  /** Where clients reach the app: the proxy when there is one, else the app itself. */
  baseUrl: string;
  /** The app itself, past any proxy. */
  appUrl: string;
  port: number;
  database?: Database;
  /** The run's own folder for files ($DATA_DIR; $HOME too with `app.isolateHome`). */
  dataDir: string;
  pid?: number;
  logDir: string;
}

/**
 * One isolated execution: a code version (worktree) + a fresh database copy and data folder +
 * a running app process + its own payment-provider tenant.
 */
export class Branch implements BranchInfo {
  readonly id: string;
  readonly version: CodeVersion;
  readonly baseUrl: string;
  readonly appUrl: string;
  readonly port: number;
  readonly database?: Database;
  readonly dataDir: string;
  readonly logDir: string;
  readonly payments?: { url: string; tenant: Tenant };
  /** The app's statements, when SQL logging is on. */
  readonly sql?: SqlLog;
  /** The HTTP proxy in front of the app, when the branch was created with one. */
  readonly proxy?: HttpProxy;
  private readonly service: Service;
  private readonly teardown: () => Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    init: BranchInfo & {
      service: Service;
      payments?: Branch["payments"];
      sql?: SqlLog;
      proxy?: HttpProxy;
      teardown: () => Promise<void>;
    },
  ) {
    this.id = init.id;
    this.version = init.version;
    this.baseUrl = init.baseUrl;
    this.appUrl = init.appUrl;
    this.port = init.port;
    this.database = init.database;
    this.dataDir = init.dataDir;
    this.logDir = init.logDir;
    this.payments = init.payments;
    this.sql = init.sql;
    this.proxy = init.proxy;
    this.service = init.service;
    this.teardown = init.teardown;
  }

  get pid(): number | undefined {
    return this.service.pid;
  }

  get running(): boolean {
    return this.service.running;
  }

  /** Stops the app and drops the run database (unless kept). Safe to call twice. */
  stop(): Promise<void> {
    this.stopping ??= this.teardown();
    return this.stopping;
  }

  info(): BranchInfo {
    return {
      id: this.id,
      version: this.version,
      baseUrl: this.baseUrl,
      appUrl: this.appUrl,
      port: this.port,
      database: this.database,
      dataDir: this.dataDir,
      pid: this.pid,
      logDir: this.logDir,
    };
  }
}

/** A fresh copy of a version's seed with no app running: for rule checks on the seed and the project's tests. */
export interface SeedCopy {
  database?: Database;
  dataDir: string;
  /** DATA_DIR, the database's variables, and HOME with `app.isolateHome`. */
  env: Record<string, string>;
}

/**
 * Creates and tears down branches. At most `parallel` branches run at once;
 * extra create() calls wait for a free slot.
 */
export class Branches {
  readonly project: Project;
  readonly versions: CodeVersions;
  /** The Postgres server, when the app's database is Postgres. */
  readonly pg?: PgServer;
  private readonly slots: Semaphore;
  private readonly live = new Set<Branch>();
  private pruning?: Promise<string[]>;
  private mockPay?: Promise<MockPay>;
  private sqlProxy?: Promise<SqlProxy | undefined>;
  private readonly sqliteBuilds = new Map<string, Promise<void>>();

  constructor(project: Project) {
    this.project = project;
    this.versions = new CodeVersions(project);
    const db = project.config.db;
    this.pg = db?.kind === "postgres" ? new PgServer(db.url) : undefined;
    this.slots = new Semaphore(project.config.parallel);
  }

  static async open(cwd?: string): Promise<Branches> {
    return new Branches(await openProject(cwd));
  }

  /** Database name prefix for everything this project creates. */
  get dbPrefix(): string {
    return `wt_${this.project.key}_`;
  }

  /** The seed snapshot (template database) of a code version. */
  snapshotName(versionId: string): string {
    return `${this.dbPrefix}seed_${versionId}`;
  }

  /** The seed snapshot of a code version when the database is SQLite: a file, never opened for writing. */
  sqliteSnapshot(versionId: string): string {
    return join(this.project.cacheDir, "sqlite", `${versionId}.db`);
  }

  /** Resolves, checks out, installs and builds a version, and builds its seed snapshot. */
  async prepare(spec: CodeVersionSpec | CodeVersion = {}): Promise<PreparedVersion> {
    const version = isResolved(spec) ? spec : await this.versions.resolve(spec);
    const isNew = !(await this.versions.list()).includes(version.id);
    const prepared = await this.versions.prepare(version);
    if (isNew) await this.prune().catch(() => []);
    const db = this.project.config.db;
    const seed = (env: Record<string, string>) =>
      sh(db!.seed, { cwd: prepared.appDir, env, logFile: this.versions.logFile(version.id) });
    if (db?.kind === "postgres") {
      await this.pg!.ensureSnapshot(this.snapshotName(version.id), (url) => seed({ DATABASE_URL: url }).then(() => undefined));
    } else if (db?.kind === "sqlite") {
      await this.ensureSqliteSnapshot(version.id, async (dataDir) => {
        const database = this.sqliteDatabase(dataDir, "");
        await mkdir(dirname(database.path), { recursive: true });
        await seed(this.stateEnv(dataDir, database));
      });
    }
    return prepared;
  }

  /** Runs `fn` against a throwaway copy of a version's seed and a new data folder (no app process). */
  async withSeedCopy<T>(spec: CodeVersionSpec | CodeVersion, fn: (copy: SeedCopy) => Promise<T>): Promise<T> {
    const { version } = await this.prepare(spec);
    const state = await this.freshState(version.id, newBranchId(), false);
    try {
      return await fn({ database: state.database, dataDir: state.dataDir, env: this.stateEnv(state.dataDir, state.database) });
    } finally {
      await state.drop().catch(() => undefined);
    }
  }

  async create(spec: CodeVersionSpec | CodeVersion = {}, options: CreateBranchOptions = {}): Promise<Branch> {
    const release = await this.slots.acquire();
    // Undo steps, run in reverse by teardown() on failure or when the branch stops.
    const cleanup: (() => unknown)[] = [release];
    let service: Service | undefined;
    const teardown = async () => {
      await service?.stop().catch(() => undefined);
      for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => undefined);
    };

    try {
      const prepared = await this.prepare(spec);
      const { version } = prepared;
      const id = newBranchId();
      const logDir = options.logDir ?? join(this.project.stateDir, "logs", "branches", id);
      await mkdir(logDir, { recursive: true });

      const state = await this.freshState(version.id, id, !!options.keepDatabase);
      cleanup.push(() => state.drop());
      const { database, dataDir } = state;
      await options.beforeStart?.(database);

      // The app reaches a Postgres database through the SQL proxy, which logs its statements.
      let appDbUrl: string | undefined;
      let sql: SqlLog | undefined;
      if (database?.kind === "postgres") {
        const sqlProxy = await this.startSqlProxy();
        sql = sqlProxy?.record(database.name);
        if (sql) cleanup.push(() => sql!.stop());
        appDbUrl = sqlProxy ? sqlProxy.urlFor(database.url) : database.url;
      }

      const port = await allocatePort();
      cleanup.push(() => releasePort(port));
      const appUrl = expandVars(this.project.config.app.baseUrl, { PORT: String(port) }).replace(/\/$/, "");
      let baseUrl = appUrl;
      let proxy: HttpProxy | undefined;
      if (options.proxy) {
        const proxyPort = await allocatePort();
        cleanup.push(() => releasePort(proxyPort));
        proxy = await HttpProxy.start({ port: proxyPort, target: appUrl });
        cleanup.push(() => proxy!.close());
        baseUrl = expandVars(this.project.config.app.baseUrl, { PORT: String(proxyPort) }).replace(/\/$/, "");
      }

      const stateEnv = this.stateEnv(dataDir, database, appDbUrl);
      const vars: Record<string, string> = { PORT: String(port), BASE_URL: baseUrl, ...stateEnv };
      let payments: Branch["payments"];
      const mockPayConfig = this.project.config.mockPay;
      if (mockPayConfig) {
        const mockPay = await this.startMockPay();
        const secret = `whsec_${randomBytes(12).toString("hex")}`;
        const tenant = mockPay.tenant(id, {
          // Webhooks come from the payment provider's servers, not a client: straight to the app.
          webhookUrl: `${appUrl}${mockPayConfig.webhookPath}`,
          webhookSecret: secret,
          webhookDelayMs: mockPayConfig.webhookDelayMs,
          chargeLatencyMs: mockPayConfig.chargeLatencyMs,
        });
        cleanup.push(() => mockPay.removeTenant(id));
        payments = { url: mockPay.tenantUrl(id), tenant };
        vars.MOCK_PAY_URL = payments.url;
        vars.MOCK_PAY_SECRET = secret;
      }

      // A Tauri app built with windtunnel-tauri serves its frontend and its commands there.
      if (this.project.config.app.kind === "tauri") vars.WINDTUNNEL_PORT = vars.PORT!;
      const scope = { ...process.env, ...vars };
      // PORT, BASE_URL, DATA_DIR and the database's variables are always set, so an app that forgets
      // to map them can't fall back to a developer database. `app.env` adds to or overrides them.
      const env: Record<string, string> = {
        PORT: vars.PORT!,
        BASE_URL: baseUrl,
        ...stateEnv,
        ...(vars.WINDTUNNEL_PORT ? { WINDTUNNEL_PORT: vars.WINDTUNNEL_PORT } : {}),
      };
      for (const [key, value] of Object.entries(this.project.config.app.env)) env[key] = expandVars(value, scope);

      const appLog = join(logDir, "app.log");
      service = await Service.start(expandVars(this.project.config.app.start, scope), {
        cwd: prepared.appDir,
        env,
        logFile: appLog,
      });

      // Lets `windtunnel clean` find this process and database if we crash.
      const pidFile = join(this.project.stateDir, "pids", `${id}.json`);
      await mkdir(join(this.project.stateDir, "pids"), { recursive: true });
      const dbName = database?.kind === "postgres" ? database.name : undefined;
      await writeFile(pidFile, JSON.stringify({ pid: service.pid, database: dbName, dataDir, port, startedAt: new Date().toISOString() }));
      cleanup.push(() => rm(pidFile, { force: true }));

      await waitForReady(`${appUrl}${this.project.config.app.ready}`, service, this.project.config.app.readyTimeoutMs, appLog);

      const branch: Branch = new Branch({
        id,
        version,
        baseUrl,
        appUrl,
        port,
        database,
        dataDir,
        logDir,
        service,
        payments,
        sql,
        proxy,
        teardown: async () => {
          this.live.delete(branch);
          await teardown();
        },
      });
      this.live.add(branch);
      return branch;
    } catch (err) {
      await teardown();
      throw err;
    }
  }

  /**
   * Every edit to the working tree is a new version, so old ones are removed: beyond the
   * `keep` most recently used, any version idle for `idleMs` loses its worktree and seed
   * snapshot. Versions in use are never removed. One prune at a time; a version that
   * can't be removed now is left for the next one.
   */
  prune(keep = 10, idleMs = 30 * 60_000): Promise<string[]> {
    this.pruning ??= this.pruneOnce(keep, idleMs).finally(() => (this.pruning = undefined));
    return this.pruning;
  }

  private async pruneOnce(keep: number, idleMs: number): Promise<string[]> {
    const inUse = new Set([...this.live].map((b) => b.version.id));
    const removed: string[] = [];
    const versions = await this.versions.listByLastUse();
    for (const { id, lastUsed } of versions.slice(keep)) {
      if (inUse.has(id) || Date.now() - lastUsed < idleMs || (await this.versions.isBusy(id))) continue;
      try {
        await this.versions.remove(id);
        await this.pg?.drop(this.snapshotName(id));
        await rm(this.sqliteSnapshot(id), { force: true });
        removed.push(id);
      } catch {
        // Another process may be pruning the same version.
      }
    }
    return removed;
  }

  /** Stops every live branch and releases shared resources. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.live].map((b) => b.stop()));
    if (this.mockPay) await (await this.mockPay).close();
    if (this.sqlProxy) await (await this.sqlProxy)?.close();
    await this.pg?.close();
  }

  /** Where the run's files go: `<cache>/data/<id>`, removed with the branch unless kept. */
  dataDirFor(id: string): string {
    return join(this.project.cacheDir, "data", id);
  }

  /** A new data folder and a copy of the version's seed database for one run or seed check. */
  private async freshState(
    versionId: string,
    id: string,
    keep: boolean,
  ): Promise<{ database?: Database; dataDir: string; drop: () => Promise<void> }> {
    const dataDir = this.dataDirFor(id);
    await mkdir(dataDir, { recursive: true });
    const undo: (() => Promise<unknown>)[] = [];
    if (!keep) undo.push(() => rm(dataDir, { recursive: true, force: true }));
    const drop = async () => {
      for (const fn of undo.reverse()) await fn().catch(() => undefined);
    };
    const db = this.project.config.db;
    let database: Database | undefined;
    try {
      if (db?.kind === "postgres") {
        const name = `${this.dbPrefix}run_${id}`;
        const url = await this.pg!.clone(this.snapshotName(versionId), name);
        if (!keep) undo.push(() => this.pg!.drop(name));
        database = { kind: "postgres", name, url };
      } else if (db?.kind === "sqlite") {
        const copy = this.sqliteDatabase(dataDir, this.sqliteSnapshot(versionId));
        await mkdir(dirname(copy.path), { recursive: true });
        await copyFile(copy.seed, copy.path);
        database = copy;
      }
    } catch (err) {
      await drop();
      throw err;
    }
    return { database, dataDir, drop };
  }

  private sqliteDatabase(dataDir: string, seed: string): Database & { kind: "sqlite" } {
    const db = this.project.config.db;
    if (db?.kind !== "sqlite") throw new Error("the app's database is not SQLite");
    return { kind: "sqlite", path: join(dataDir, db.file), seed };
  }

  /** The variables that point a process at a run's state. `postgresUrl` overrides the URL the app gets (the SQL proxy). */
  private stateEnv(dataDir: string, database: Database | undefined, postgresUrl?: string): Record<string, string> {
    return {
      DATA_DIR: dataDir,
      ...databaseEnv(database, postgresUrl),
      ...(this.project.config.app.isolateHome ? { HOME: dataDir } : {}),
    };
  }

  /**
   * Builds a version's SQLite snapshot once: the seed runs in a new data folder, then the
   * file is checkpointed and moved into place, so a half-built snapshot is never used.
   */
  private ensureSqliteSnapshot(versionId: string, build: (dataDir: string) => Promise<void>): Promise<void> {
    let pending = this.sqliteBuilds.get(versionId);
    if (!pending) {
      pending = (async () => {
        const target = this.sqliteSnapshot(versionId);
        if (await exists(target)) return;
        const dataDir = join(this.project.cacheDir, "sqlite", `${versionId}.build-${newBranchId()}`);
        await mkdir(dataDir, { recursive: true });
        try {
          await build(dataDir);
          const { path } = this.sqliteDatabase(dataDir, "");
          if (!(await exists(path))) throw new Error(`the seed command did not create the database at $DATABASE_PATH (${path})`);
          // Writes still in a write-ahead log go into the file, which is copied alone.
          const conn = await openSqlite(path);
          try {
            conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
          } finally {
            conn.close();
          }
          await rename(path, target);
        } finally {
          await rm(dataDir, { recursive: true, force: true });
        }
      })().finally(() => this.sqliteBuilds.delete(versionId));
      this.sqliteBuilds.set(versionId, pending);
    }
    return pending;
  }

  private startMockPay(): Promise<MockPay> {
    this.mockPay ??= MockPay.start();
    return this.mockPay;
  }

  /** One proxy for every branch; off when disabled in the config or the server needs TLS. */
  private startSqlProxy(): Promise<SqlProxy | undefined> {
    const db = this.project.config.db;
    if (db?.kind !== "postgres") return Promise.resolve(undefined);
    const { url, sqlLog } = db;
    const u = new URL(url);
    const tls = /^(require|verify-ca|verify-full)$/.test(u.searchParams.get("sslmode") ?? "") || u.searchParams.get("ssl") === "true";
    if (!sqlLog || tls) return Promise.resolve(undefined);
    this.sqlProxy ??= SqlProxy.start({ host: u.hostname || "127.0.0.1", port: Number(u.port || 5432) });
    return this.sqlProxy;
  }
}

async function waitForReady(url: string, service: Service, timeoutMs: number, logFile: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!service.running) throw new Error(`app exited before it was ready; see ${logFile}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
      await res.arrayBuffer();
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`app did not answer ${url} within ${timeoutMs} ms; see ${logFile}`);
}

function isResolved(spec: CodeVersionSpec | CodeVersion): spec is CodeVersion {
  return "tree" in spec && typeof spec.tree === "string";
}

function newBranchId(): string {
  return `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(size: number) {
    this.available = size;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

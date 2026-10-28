import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockPay, type Tenant } from "@windtunnel/mock-pay";
import { expandVars } from "../config.ts";
import { Service, sh } from "../exec.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { openProject, type Project } from "../project.ts";
import { type CodeVersion, type CodeVersionSpec, CodeVersions, type PreparedVersion } from "./code-versions.ts";
import { PgServer } from "./postgres.ts";
import { type SqlLog, SqlProxy } from "./sql-log.ts";

export interface CreateBranchOptions {
  /** Keep the run database after stop() for inspection. */
  keepDatabase?: boolean;
  /** Where the app log goes (default `.windtunnel/logs/branches/<id>`). */
  logDir?: string;
  /** Runs after the database copy exists and before the app starts. */
  beforeStart?: (database: { name: string; url: string }) => Promise<void>;
}

export interface BranchInfo {
  id: string;
  version: CodeVersion;
  baseUrl: string;
  port: number;
  database: { name: string; url: string };
  pid?: number;
  logDir: string;
}

/**
 * One isolated execution: a code version (worktree) + a fresh database copy +
 * a running app process + its own payment-provider tenant.
 */
export class Branch implements BranchInfo {
  readonly id: string;
  readonly version: CodeVersion;
  readonly baseUrl: string;
  readonly port: number;
  readonly database: { name: string; url: string };
  readonly logDir: string;
  readonly payments?: { url: string; tenant: Tenant };
  /** The app's statements, when SQL logging is on. */
  readonly sql?: SqlLog;
  private readonly service: Service;
  private readonly teardown: () => Promise<void>;
  private stopping?: Promise<void>;

  constructor(
    init: BranchInfo & { service: Service; payments?: Branch["payments"]; sql?: SqlLog; teardown: () => Promise<void> },
  ) {
    this.id = init.id;
    this.version = init.version;
    this.baseUrl = init.baseUrl;
    this.port = init.port;
    this.database = init.database;
    this.logDir = init.logDir;
    this.payments = init.payments;
    this.sql = init.sql;
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
      port: this.port,
      database: this.database,
      pid: this.pid,
      logDir: this.logDir,
    };
  }
}

/**
 * Creates and tears down branches. At most `parallel` branches run at once;
 * extra create() calls wait for a free slot.
 */
export class Branches {
  readonly project: Project;
  readonly versions: CodeVersions;
  readonly pg: PgServer;
  private readonly slots: Semaphore;
  private readonly live = new Set<Branch>();
  private pruning?: Promise<string[]>;
  private mockPay?: Promise<MockPay>;
  private sqlProxy?: Promise<SqlProxy | undefined>;

  constructor(project: Project) {
    this.project = project;
    this.versions = new CodeVersions(project);
    this.pg = new PgServer(project.config.db.url);
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

  /** Resolves, checks out, installs and builds a version, and builds its seed snapshot. */
  async prepare(spec: CodeVersionSpec | CodeVersion = {}): Promise<PreparedVersion> {
    const version = isResolved(spec) ? spec : await this.versions.resolve(spec);
    const isNew = !(await this.versions.list()).includes(version.id);
    const prepared = await this.versions.prepare(version);
    if (isNew) await this.prune().catch(() => []);
    await this.pg.ensureSnapshot(this.snapshotName(version.id), async (url) => {
      await sh(this.project.config.db.seed, {
        cwd: prepared.appDir,
        env: { DATABASE_URL: url },
        logFile: this.versions.logFile(version.id),
      });
    });
    return prepared;
  }

  /** Runs `fn` against a throwaway copy of a version's seed snapshot (no app process). */
  async withSeedCopy<T>(spec: CodeVersionSpec | CodeVersion, fn: (url: string) => Promise<T>): Promise<T> {
    const { version } = await this.prepare(spec);
    const name = `${this.dbPrefix}run_${newBranchId()}`;
    const url = await this.pg.clone(this.snapshotName(version.id), name);
    try {
      return await fn(url);
    } finally {
      await this.pg.drop(name).catch(() => undefined);
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

      const dbName = `${this.dbPrefix}run_${id}`;
      const dbUrl = await this.pg.clone(this.snapshotName(version.id), dbName);
      if (!options.keepDatabase) cleanup.push(() => this.pg.drop(dbName));
      await options.beforeStart?.({ name: dbName, url: dbUrl });

      // The app reaches its database through the SQL proxy, which logs its statements.
      const proxy = await this.startSqlProxy();
      const sql = proxy?.record(dbName);
      if (sql) cleanup.push(() => sql.stop());
      const appDbUrl = proxy ? proxy.urlFor(dbUrl) : dbUrl;

      const port = await allocatePort();
      cleanup.push(() => releasePort(port));
      const baseUrl = expandVars(this.project.config.app.baseUrl, { PORT: String(port) }).replace(/\/$/, "");

      const vars: Record<string, string> = { PORT: String(port), BASE_URL: baseUrl, DATABASE_URL: appDbUrl };
      let payments: Branch["payments"];
      const mockPayConfig = this.project.config.mockPay;
      if (mockPayConfig) {
        const mockPay = await this.startMockPay();
        const secret = `whsec_${randomBytes(12).toString("hex")}`;
        const tenant = mockPay.tenant(id, {
          webhookUrl: `${baseUrl}${mockPayConfig.webhookPath}`,
          webhookSecret: secret,
          webhookDelayMs: mockPayConfig.webhookDelayMs,
          chargeLatencyMs: mockPayConfig.chargeLatencyMs,
        });
        cleanup.push(() => mockPay.removeTenant(id));
        payments = { url: mockPay.tenantUrl(id), tenant };
        vars.MOCK_PAY_URL = payments.url;
        vars.MOCK_PAY_SECRET = secret;
      }

      const scope = { ...process.env, ...vars };
      // PORT, DATABASE_URL and BASE_URL are always set, so an app that forgets to
      // map them can't fall back to a developer database. `app.env` adds to or overrides them.
      const env: Record<string, string> = { PORT: vars.PORT!, DATABASE_URL: appDbUrl, BASE_URL: baseUrl };
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
      await writeFile(pidFile, JSON.stringify({ pid: service.pid, database: dbName, port, startedAt: new Date().toISOString() }));
      cleanup.push(() => rm(pidFile, { force: true }));

      await waitForReady(`${baseUrl}${this.project.config.app.ready}`, service, this.project.config.app.readyTimeoutMs, appLog);

      const branch: Branch = new Branch({
        id,
        version,
        baseUrl,
        port,
        database: { name: dbName, url: dbUrl },
        logDir,
        service,
        payments,
        sql,
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
        await this.pg.drop(this.snapshotName(id));
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
    await this.pg.close();
  }

  private startMockPay(): Promise<MockPay> {
    this.mockPay ??= MockPay.start();
    return this.mockPay;
  }

  /** One proxy for every branch; off when disabled in the config or the server needs TLS. */
  private startSqlProxy(): Promise<SqlProxy | undefined> {
    const { url, sqlLog } = this.project.config.db;
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

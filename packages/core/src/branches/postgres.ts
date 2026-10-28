import pg from "pg";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const READY_COMMENT = "windtunnel snapshot (ready)";

/**
 * Admin access to the Postgres server that holds snapshots and per-run copies.
 * Snapshots are template databases; a run copy is `CREATE DATABASE … TEMPLATE`.
 */
export class PgServer {
  private readonly serverUrl: URL;
  private readonly admin: pg.Pool;
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(url: string) {
    this.serverUrl = new URL(url);
    this.admin = new pg.Pool({
      connectionString: this.urlFor("postgres"),
      max: 4,
      application_name: "windtunnel",
    });
  }

  urlFor(database: string): string {
    const url = new URL(this.serverUrl.href);
    url.pathname = `/${database}`;
    return url.href;
  }

  async ping(): Promise<string> {
    const { rows } = await this.admin.query<{ server_version: string }>("SHOW server_version");
    return rows[0]!.server_version;
  }

  async exists(name: string): Promise<boolean> {
    const { rowCount } = await this.admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return rowCount === 1;
  }

  /**
   * Builds the snapshot once. `build` fills the empty database (schema + seed).
   * A half-built snapshot from a crashed run is dropped and rebuilt.
   */
  ensureSnapshot(name: string, build: (url: string) => Promise<void>): Promise<void> {
    let pending = this.inflight.get(name);
    if (!pending) {
      pending = this.buildSnapshot(name, build).finally(() => this.inflight.delete(name));
      this.inflight.set(name, pending);
    }
    return pending;
  }

  async clone(snapshot: string, name: string): Promise<string> {
    await this.admin.query(`CREATE DATABASE ${ident(name)} TEMPLATE ${ident(snapshot)}`);
    return this.urlFor(name);
  }

  async drop(name: string): Promise<void> {
    if (!(await this.exists(name))) return;
    await this.admin.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE false`);
    await this.admin.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
  }

  async list(prefix: string): Promise<string[]> {
    const { rows } = await this.admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname",
      [prefix],
    );
    return rows.map((r) => r.datname);
  }

  async close(): Promise<void> {
    await this.admin.end();
  }

  private async buildSnapshot(name: string, build: (url: string) => Promise<void>): Promise<void> {
    // An advisory lock serialises builders across processes sharing this server.
    const lock = await this.admin.connect();
    try {
      await lock.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
      if (await this.isReadySnapshot(name)) return;
      await this.drop(name);
      await this.admin.query(`CREATE DATABASE ${ident(name)}`);
      try {
        await build(this.urlFor(name));
      } catch (err) {
        await this.drop(name).catch(() => undefined);
        throw err;
      }
      await this.admin.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE true`);
      await this.admin.query(`COMMENT ON DATABASE ${ident(name)} IS '${READY_COMMENT}'`);
    } finally {
      await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => undefined);
      lock.release();
    }
  }

  private async isReadySnapshot(name: string): Promise<boolean> {
    const { rows } = await this.admin.query<{ comment: string | null }>(
      "SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1",
      [name],
    );
    return rows[0]?.comment === READY_COMMENT;
  }
}

function ident(name: string): string {
  if (!NAME.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
}

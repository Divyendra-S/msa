import pg from "pg";

const NAME = /^[a-z_][a-z0-9_]{0,62}$/;

type Queryable = Pick<pg.Pool, "query">;
/** Bumped when snapshots change shape (v2: the windtunnel_seed schema), so older ones are rebuilt. */
const READY_COMMENT = "windtunnel snapshot v2 (ready)";

/** Read-only copy of the seed data in every snapshot, for rules that compare with the start. */
export const SEED_SCHEMA = "windtunnel_seed";

const COPY_SEED = `
DO $$
DECLARE t record;
BEGIN
  CREATE SCHEMA ${SEED_SCHEMA};
  FOR t IN SELECT schemaname, tablename FROM pg_tables
            WHERE schemaname NOT IN ('pg_catalog', 'information_schema', '${SEED_SCHEMA}')
              AND schemaname NOT LIKE 'pg\\_%'
  LOOP
    EXECUTE format('CREATE TABLE ${SEED_SCHEMA}.%I AS TABLE %I.%I',
      CASE WHEN t.schemaname = 'public' THEN t.tablename ELSE t.schemaname || '_' || t.tablename END,
      t.schemaname, t.tablename);
  END LOOP;
END $$`;

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
    // Idle connections can be closed by the server; the pool replaces them.
    this.admin.on("error", () => undefined);
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

  async drop(name: string, db: Queryable = this.admin): Promise<void> {
    const { rowCount } = await db.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount !== 1) return;
    await db.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE false`);
    await db.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);
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
    if (await this.isReadySnapshot(this.admin, name)) return;
    // An advisory lock serialises builders across processes sharing this server.
    // Every query below uses the locked connection, so concurrent builders can't
    // exhaust the pool while they wait.
    const db = await this.admin.connect();
    try {
      await db.query("SELECT pg_advisory_lock(hashtext($1))", [name]);
      if (await this.isReadySnapshot(db, name)) return;
      await this.drop(name, db);
      await db.query(`CREATE DATABASE ${ident(name)}`);
      try {
        await build(this.urlFor(name));
        await copySeed(this.urlFor(name));
      } catch (err) {
        await this.drop(name, db).catch(() => undefined);
        throw err;
      }
      await db.query(`ALTER DATABASE ${ident(name)} WITH IS_TEMPLATE true`);
      await db.query(`COMMENT ON DATABASE ${ident(name)} IS '${READY_COMMENT}'`);
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtext($1))", [name]).catch(() => undefined);
      db.release();
    }
  }

  private async isReadySnapshot(db: Queryable, name: string): Promise<boolean> {
    const { rows } = await db.query<{ comment: string | null }>(
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

async function copySeed(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url, application_name: "windtunnel" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query(COPY_SEED);
  } finally {
    await client.end();
  }
}

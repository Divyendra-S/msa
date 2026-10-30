import type { DatabaseSync } from "node:sqlite";
import pg from "pg";

/** A run's database: a copy on the Postgres server, or a SQLite file in the run's data folder. */
export type Database =
  | { kind: "postgres"; name: string; url: string }
  | {
      kind: "sqlite";
      /** The run's copy, the file the app opens. */
      path: string;
      /** The version's seed snapshot (read-only), attached as `windtunnel_seed` for rules. */
      seed: string;
    };

/** Where the app and scripts find a database: `DATABASE_URL`, plus `DATABASE_PATH` for SQLite. */
export function databaseEnv(db: Database | undefined, postgresUrl = db?.kind === "postgres" ? db.url : undefined): Record<string, string> {
  if (!db) return {};
  if (db.kind === "postgres") return { DATABASE_URL: postgresUrl ?? db.url };
  return { DATABASE_URL: `file:${db.path}`, DATABASE_PATH: db.path };
}

/** One line for logs and the CLI: the Postgres URL or the SQLite file. */
export function describeDatabase(db: Database | undefined): string {
  if (!db) return "none";
  return db.kind === "postgres" ? db.url : db.path;
}

/**
 * Opens a SQLite file with Node's built-in driver. Loaded on first use, so apps on Postgres
 * never load it (it is still marked experimental in some Node versions).
 */
export async function openSqlite(path: string, options: { readOnly?: boolean } = {}): Promise<DatabaseSync> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: !!options.readOnly });
  // The app may be writing at the same moment.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Runs one statement against a run's database (a `sql` perturbation); returns the affected row count. */
export async function runStatement(db: Database | undefined, sql: string): Promise<number> {
  if (!db) throw new Error("sql perturbation: this run has no database");
  if (db.kind === "sqlite") {
    const conn = await openSqlite(db.path);
    try {
      return Number(conn.prepare(sql).run().changes);
    } finally {
      conn.close();
    }
  }
  const client = new pg.Client({ connectionString: db.url, application_name: "windtunnel-perturb" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query(sql)).rowCount ?? 0;
  } finally {
    await client.end();
  }
}

/** SQLite values as JSON-friendly ones: blobs in Postgres's `\x…` text form. */
export function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array
        ? `\\x${Buffer.from(value).toString("hex")}`
        : typeof value === "bigint"
          ? Number(value)
          : value;
  }
  return out;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

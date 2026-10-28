import { Pool, type PoolClient } from "pg";

const globalForDb = globalThis as unknown as { shopPool?: Pool };

export const pool =
  globalForDb.shopPool ??
  new Pool({ connectionString: process.env.DATABASE_URL, max: 10, application_name: "shop" });

if (process.env.NODE_ENV !== "production") globalForDb.shopPool = pool;

export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

export async function queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

import pg from "pg";

export type Row = Record<string, unknown>;

export interface TableSnapshot {
  /** Primary key columns; empty when the table has none. */
  key: string[];
  count: number;
  /** Absent when the table has more than `maxRows` rows (only the count is compared). */
  rows?: Row[];
}

/** Table name (`schema.table`, or just `table` in `public`) → contents. */
export type DbSnapshot = Record<string, TableSnapshot>;

export interface RowChange {
  key: Row;
  /** column → [before, after] */
  changes: Record<string, [unknown, unknown]>;
}

export interface TableDiff {
  added: Row[];
  removed: Row[];
  changed: RowChange[];
  /** Set when the table was too large to compare row by row. */
  countOnly?: { before: number; after: number };
}

export interface DbDiff {
  tables: Record<string, TableDiff>;
  /** e.g. `orders +2 · products ~1` */
  summary: string;
}

const TABLES_SQL = `
SELECT n.nspname AS schema, c.relname AS name,
       coalesce((SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum))
                   FROM pg_index i
                   JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                  WHERE i.indrelid = c.oid AND i.indisprimary), '{}') AS key
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
   AND n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND n.nspname NOT LIKE 'pg\\_%'
 ORDER BY 1, 2`;

/** Reads every user table. Meant for seeded, demo-size databases. */
export async function snapshotDatabase(url: string, maxRows = 2_000): Promise<DbSnapshot> {
  const client = new pg.Client({ connectionString: url, application_name: "windtunnel-diff" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: tables } = await client.query<{ schema: string; name: string; key: string[] }>(TABLES_SQL);
    const snapshot: DbSnapshot = {};
    for (const table of tables) {
      const ident = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
      const order = table.key.length > 0 ? ` ORDER BY ${table.key.map(quoteIdent).join(", ")}` : "";
      const { rows } = await client.query<{ r: string }>(
        `SELECT row_to_json(t)::text AS r FROM ${ident} t${order} LIMIT ${maxRows + 1}`,
      );
      const name = table.schema === "public" ? table.name : `${table.schema}.${table.name}`;
      if (rows.length > maxRows) {
        const { rows: counted } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident}`);
        snapshot[name] = { key: table.key, count: counted[0]!.n };
      } else {
        snapshot[name] = { key: table.key, count: rows.length, rows: rows.map((r) => JSON.parse(r.r) as Row) };
      }
    }
    await client.query("COMMIT");
    return snapshot;
  } finally {
    await client.end();
  }
}

/** Row-level differences, keyed by primary key (whole-row comparison for tables without one). */
export function diffSnapshots(before: DbSnapshot, after: DbSnapshot): DbDiff {
  const tables: Record<string, TableDiff> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name] ?? { key: after[name]!.key, count: 0, rows: [] };
    const b = after[name] ?? { key: a.key, count: 0, rows: [] };
    const diff = a.rows && b.rows ? diffRows(b.key, a.rows, b.rows) : countDiff(a.count, b.count);
    if (diff.added.length || diff.removed.length || diff.changed.length || diff.countOnly) tables[name] = diff;
  }
  return { tables, summary: summarize(tables) };
}

function diffRows(key: string[], before: Row[], after: Row[]): TableDiff {
  const id = (row: Row) => JSON.stringify(key.length > 0 ? key.map((k) => row[k]) : row);
  const old = new Map<string, Row[]>();
  for (const row of before) {
    const k = id(row);
    old.set(k, [...(old.get(k) ?? []), row]);
  }
  const diff: TableDiff = { added: [], removed: [], changed: [] };
  for (const row of after) {
    const k = id(row);
    const match = old.get(k)?.shift();
    if (!match) {
      diff.added.push(row);
      continue;
    }
    if (key.length === 0) continue;
    const changes: Record<string, [unknown, unknown]> = {};
    for (const column of new Set([...Object.keys(match), ...Object.keys(row)])) {
      if (JSON.stringify(match[column]) !== JSON.stringify(row[column])) changes[column] = [match[column], row[column]];
    }
    if (Object.keys(changes).length > 0) {
      diff.changed.push({ key: Object.fromEntries(key.map((k) => [k, row[k]])), changes });
    }
  }
  for (const rows of old.values()) diff.removed.push(...rows);
  return diff;
}

function countDiff(before: number, after: number): TableDiff {
  return { added: [], removed: [], changed: [], ...(before !== after ? { countOnly: { before, after } } : {}) };
}

function summarize(tables: Record<string, TableDiff>): string {
  const parts = Object.entries(tables).map(([name, d]) => {
    if (d.countOnly) return `${name} ${d.countOnly.before}→${d.countOnly.after} rows`;
    const bits = [
      d.added.length ? `+${d.added.length}` : "",
      d.removed.length ? `-${d.removed.length}` : "",
      d.changed.length ? `~${d.changed.length}` : "",
    ].filter(Boolean);
    return `${name} ${bits.join(" ")}`;
  });
  return parts.join(" · ") || "no changes";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

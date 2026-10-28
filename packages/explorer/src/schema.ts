import pg from "pg";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  /** Omitted for serial/identity columns. */
  default?: string;
  /** serial or identity */
  generated?: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  /** Unique constraints and unique indexes, e.g. `(cart_id)` or `(user_id) WHERE status = 'open'`. */
  unique: string[];
  foreignKeys: { columns: string[]; table: string }[];
  checks: string[];
  rows: number;
}

const COLUMNS = `
SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS name, c.data_type AS type,
       c.is_nullable = 'YES' AS nullable, c.column_default AS default, c.is_identity = 'YES' AS identity
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
 WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'windtunnel_seed')
 ORDER BY c.table_schema, c.table_name, c.ordinal_position`;

const CONSTRAINTS = `
SELECT n.nspname AS schema, cl.relname AS table, con.contype AS type, pg_get_constraintdef(con.oid) AS def,
       fcl.relname AS ref
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
  LEFT JOIN pg_class fcl ON fcl.oid = con.confrelid
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'windtunnel_seed') AND con.contype IN ('p', 'u', 'f', 'c')`;

/** Unique indexes not backed by a constraint (partial or expression indexes). */
const UNIQUE_INDEXES = `
SELECT n.nspname AS schema, cl.relname AS table, pg_get_indexdef(i.indexrelid) AS def
  FROM pg_index i
  JOIN pg_class cl ON cl.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = cl.relnamespace
 WHERE i.indisunique AND NOT i.indisprimary
   AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'windtunnel_seed')
   AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`;

/** Reads tables, keys, constraints and row counts. Meant for seeded, demo-size databases. */
export async function readSchema(url: string): Promise<TableInfo[]> {
  const client = new pg.Client({ connectionString: url, application_name: "windtunnel-map" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    const tables = new Map<string, TableInfo>();
    const nameOf = (schema: string, table: string) => (schema === "public" ? table : `${schema}.${table}`);
    const get = (schema: string, table: string) => {
      const name = nameOf(schema, table);
      let t = tables.get(name);
      if (!t) {
        t = { name, columns: [], primaryKey: [], unique: [], foreignKeys: [], checks: [], rows: 0 };
        tables.set(name, t);
      }
      return t;
    };
    const columns = await client.query<{ schema: string; table: string; name: string; type: string; nullable: boolean; default: string | null; identity: boolean }>(COLUMNS);
    for (const c of columns.rows) {
      const serial = c.identity || /^nextval\(/.test(c.default ?? "");
      get(c.schema, c.table).columns.push({
        name: c.name,
        type: shortType(c.type),
        nullable: c.nullable,
        ...(c.default && !serial ? { default: c.default.replace(/::[\w ]+$/, "") } : {}),
        ...(serial ? { generated: true } : {}),
      });
    }
    const constraints = await client.query<{ schema: string; table: string; type: string; def: string; ref: string | null }>(CONSTRAINTS);
    for (const c of constraints.rows) {
      const t = get(c.schema, c.table);
      const cols = /\(([^)]*)\)/.exec(c.def)?.[1]?.split(",").map((s) => s.trim().replace(/"/g, "")) ?? [];
      if (c.type === "p") t.primaryKey = cols;
      else if (c.type === "u") t.unique.push(`(${cols.join(", ")})`);
      else if (c.type === "f" && c.ref) t.foreignKeys.push({ columns: cols, table: c.ref });
      else if (c.type === "c") t.checks.push(c.def.replace(/^CHECK \((.*)\)$/, "$1").replace(/^\((.*)\)$/, "$1"));
    }
    const indexes = await client.query<{ schema: string; table: string; def: string }>(UNIQUE_INDEXES);
    for (const i of indexes.rows) {
      const m = /USING \w+ \((.*?)\)(?: WHERE (.*))?$/.exec(i.def);
      const where = m?.[2]?.replace(/^\((.*)\)$/, "$1").replace(/::\w+/g, "");
      if (m) get(i.schema, i.table).unique.push(`(${m[1]})${where ? ` WHERE ${where}` : ""}`);
    }
    for (const t of tables.values()) {
      const ident = t.name.split(".").map((p) => `"${p.replace(/"/g, '""')}"`).join(".");
      const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident}`);
      t.rows = rows[0]!.n;
    }
    return [...tables.values()].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.end();
  }
}

/** Unique column sets that identify a row by meaning: unique constraints, and the primary key unless it is generated. */
export function naturalKeys(t: TableInfo): string[] {
  const pkGenerated = t.primaryKey.length === 1 && t.columns.find((c) => c.name === t.primaryKey[0])?.generated;
  return [...t.unique, ...(t.primaryKey.length > 0 && !pkGenerated ? [`(${t.primaryKey.join(", ")})`] : [])];
}

/** `orders(id PK, user_id→users, cart_id→carts UNIQUE, status in(pending|paid), paid_at?) 0 rows` */
export function formatTable(t: TableInfo): string {
  const cols = t.columns.map((c) => {
    const bits = [c.name];
    if (t.primaryKey.length === 1 && t.primaryKey[0] === c.name) bits.push("PK");
    const fk = t.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
    if (fk) bits[0] += `→${fk.table}`;
    else if (!/_id$|^id$/.test(c.name) || bits.length === 1) bits.push(c.type);
    if (t.unique.includes(`(${c.name})`)) bits.push("UNIQUE");
    const enumCheck = t.checks.find((ch) => new RegExp(`\\b${c.name}\\b.*= ANY`).test(ch));
    if (enumCheck) bits.push(`in(${[...enumCheck.matchAll(/'([^']*)'/g)].map((m) => m[1]).join("|")})`);
    if (c.default) bits.push(`=${c.default.replace(/^'(.*)'$/, "$1")}`);
    return bits.join(" ") + (c.nullable ? "?" : "");
  });
  const extra = [
    ...(t.primaryKey.length > 1 ? [`PK(${t.primaryKey.join(", ")})`] : []),
    ...t.unique.filter((u) => !t.columns.some((c) => u === `(${c.name})`)).map((u) => `UNIQUE${u}`),
    ...t.foreignKeys.filter((f) => f.columns.length > 1).map((f) => `FK(${f.columns.join(", ")})→${f.table}`),
    ...t.checks.filter((ch) => !/= ANY/.test(ch)).map((ch) => `CHECK(${ch})`),
  ];
  return `${t.name}(${[...cols, ...extra].join(", ")}) ${t.rows} row${t.rows === 1 ? "" : "s"}`;
}

function shortType(type: string): string {
  return (
    {
      integer: "int",
      bigint: "int8",
      smallint: "int2",
      "character varying": "text",
      text: "text",
      boolean: "bool",
      "timestamp with time zone": "ts",
      "timestamp without time zone": "ts",
      numeric: "num",
      "double precision": "float",
      jsonb: "json",
      json: "json",
      uuid: "uuid",
      date: "date",
    } as Record<string, string>
  )[type] ?? type;
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "./config.ts";
import { type Database, databaseEnv, openSqlite, plainRow } from "./database.ts";
import { runScript } from "./exec.ts";
import type { Project } from "./project.ts";

export const RULES_FILE = "rules.yaml";
const MAX_ROWS = 20;
const CHECK_TIMEOUT_MS = 30_000;

const RuleSchema = z
  .object({
    description: z.string().optional(),
    /** A query that lists the rows breaking the rule. */
    sql: z.string().optional(),
    /**
     * A command that prints the rows breaking the rule, one JSON object per line: for files,
     * media and anything else SQL can't read. It runs in the app's folder with the run's
     * DATA_DIR, database variables and BASE_URL, and gets the run facts as JSON on stdin.
     */
    check: z.string().optional(),
    expect: z.literal("empty").default("empty"),
  })
  .refine((r) => (r.sql === undefined) !== (r.check === undefined), { message: "a rule has either sql or check (not both)" });

const RulesFileSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "rule ids are lower-case-with-dashes"), RuleSchema);

export type Rule = { id: string; description?: string; expect: "empty" } & (
  | { sql: string; check?: undefined }
  | { check: string; sql?: undefined }
);

/**
 * What happened at the edges of one run, as tables rules can join with the app's own:
 * `windtunnel_requests` (every request, its user and status) and `windtunnel_pages` (what
 * each page said when a step ended). They are temporary tables of the rule check's session,
 * so the app's database is never changed.
 */
export interface RunFacts {
  requests: RequestFact[];
  pages: PageFact[];
}

export interface RequestFact {
  id: number;
  tab: string;
  user_name: string | null;
  user_email: string | null;
  step: string | null;
  method: string;
  /** Path without the query string. */
  path: string;
  query: string | null;
  /** Null when no answer arrived. */
  status: number | null;
  failure: string | null;
  /** False when the harness answered and the app never saw the request. */
  reached_app: boolean;
  /** ms since the run started. */
  at_ms: number;
  /** What the harness did to it, `; `-separated. */
  harness: string | null;
}

export interface PageFact {
  tab: string;
  user_name: string | null;
  user_email: string | null;
  step: string;
  /** `repeat 1`, `resubmit`… when a perturbation ran the step again. */
  attempt: string | null;
  /** When the step ended, ms since the run started. */
  at_ms: number;
  path: string;
  /** The page's visible text (first 2,000 characters). */
  text: string;
}

export const FACT_TABLES = {
  windtunnel_requests:
    "id int, tab text, user_name text, user_email text, step text, method text, path text, query text, status int, failure text, reached_app boolean, at_ms int, harness text",
  windtunnel_pages: "tab text, user_name text, user_email text, step text, attempt text, at_ms int, path text, text text",
} as const;

export type FactTable = keyof typeof FACT_TABLES;

/** The run-fact tables a query reads. */
export function factTablesOf(sql: string): FactTable[] {
  return (Object.keys(FACT_TABLES) as FactTable[]).filter((name) => new RegExp(`\\b${name}\\b`, "i").test(sql));
}

export interface RuleResult {
  id: string;
  ok: boolean;
  /** Offending rows (at most 20). */
  rows: Record<string, unknown>[];
  error?: string;
}

export function parseRules(text: string, source = RULES_FILE): Rule[] {
  const result = RulesFileSchema.safeParse(parseYaml(text) ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${source}: invalid rules\n${issues.join("\n")}`);
  }
  return Object.entries(result.data).map(([id, rule]) => ({ id, ...rule }) as Rule);
}

/** What a rule checks, in one line: its SQL or its command. */
export function ruleSource(rule: Rule): string {
  return rule.sql !== undefined ? rule.sql : `check: ${rule.check}`;
}

/** Loads `.windtunnel/rules.yaml`; a project without one has no rules. */
export async function loadRules(project: Project): Promise<Rule[]> {
  const path = join(project.stateDir, RULES_FILE);
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? [] : parseRules(text, path);
}

/** Where rules run: the run's database, and the folder and variables for `check:` commands. */
export interface RuleTarget {
  /** Without one, SQL rules see only the run facts (in an in-memory SQLite database). */
  database?: Database;
  cwd: string;
  /** DATA_DIR, BASE_URL…; the database's variables are added. */
  env?: Record<string, string>;
}

/**
 * Checks every rule: SQL read-only against the database, `check:` commands in `target.cwd`.
 * Rules that read run facts see `facts` (empty tables without them, e.g. on the seed data).
 */
export async function checkRules(target: RuleTarget, rules: Rule[], facts?: RunFacts): Promise<RuleResult[]> {
  const sqlRules = rules.filter((r): r is Rule & { sql: string } => r.sql !== undefined);
  const results = new Map<string, RuleResult>();
  if (sqlRules.length > 0) {
    const db = target.database;
    const sqlResults =
      db?.kind === "postgres"
        ? await checkPostgres(db.url, sqlRules, facts)
        : await checkSqlite(db?.kind === "sqlite" ? db : undefined, sqlRules, facts);
    for (const r of sqlResults) results.set(r.id, r);
  }
  for (const rule of rules) {
    if (rule.check !== undefined) results.set(rule.id, await runCheck(rule.id, rule.check, target, facts));
  }
  return rules.map((r) => results.get(r.id)!);
}

async function checkPostgres(databaseUrl: string, rules: (Rule & { sql: string })[], facts?: RunFacts): Promise<RuleResult[]> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "windtunnel-rules" });
  // A dropped connection fails the running query; without a listener it would crash the process.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5s'");
    for (const table of new Set(rules.flatMap((r) => factTablesOf(r.sql)))) {
      await client.query(`CREATE TEMP TABLE ${table} (${FACT_TABLES[table]})`);
      const rows = facts ? (table === "windtunnel_requests" ? facts.requests : facts.pages) : [];
      if (rows.length) await client.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1)`, [JSON.stringify(rows)]);
    }
    const results: RuleResult[] = [];
    for (const rule of rules) {
      const sql = rule.sql.trim().replace(/;+\s*$/, "");
      try {
        await client.query("BEGIN READ ONLY");
        const { rows } = await client.query<Record<string, unknown>>(`SELECT * FROM (${sql}) AS rule_rows LIMIT ${MAX_ROWS}`);
        results.push({ id: rule.id, ok: rows.length === 0, rows });
      } catch (err) {
        results.push({ id: rule.id, ok: false, rows: [], error: (err as Error).message });
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
    return results;
  } finally {
    await client.end();
  }
}

/** SQL rules on a SQLite file opened read-only, its seed attached as `windtunnel_seed`; or on the facts alone. */
async function checkSqlite(
  db: (Database & { kind: "sqlite" }) | undefined,
  rules: (Rule & { sql: string })[],
  facts?: RunFacts,
): Promise<RuleResult[]> {
  const conn = await openSqlite(db?.path ?? ":memory:", { readOnly: !!db });
  try {
    // Attached files share the connection's read-only flag.
    if (db?.seed) conn.exec(`ATTACH DATABASE '${db.seed.replace(/'/g, "''")}' AS windtunnel_seed`);
    for (const table of new Set(rules.flatMap((r) => factTablesOf(r.sql)))) {
      const columns = FACT_TABLES[table].split(",").map((c) => c.trim().split(/\s+/)[0]!);
      conn.exec(`CREATE TEMP TABLE ${table} (${FACT_TABLES[table]})`);
      const insert = conn.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(", ")})`);
      const rows = facts ? (table === "windtunnel_requests" ? facts.requests : facts.pages) : [];
      for (const row of rows as unknown as Record<string, unknown>[]) {
        insert.run(...columns.map((c) => sqliteValue(row[c])));
      }
    }
    return rules.map((rule) => {
      const sql = rule.sql.trim().replace(/;+\s*$/, "");
      try {
        const rows = conn.prepare(`SELECT * FROM (${sql}) AS rule_rows LIMIT ${MAX_ROWS}`).all() as Record<string, unknown>[];
        return { id: rule.id, ok: rows.length === 0, rows: rows.map((r) => plainRow({ ...r })) };
      } catch (err) {
        const message = (err as Error).message;
        const hint = !db && /no such table/.test(message) ? " (the app has no database in the config: SQL rules can read only windtunnel_requests and windtunnel_pages)" : "";
        return { id: rule.id, ok: false, rows: [], error: message + hint };
      }
    });
  } finally {
    conn.close();
  }
}

function sqliteValue(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Runs a `check:` command; each line it prints is a row breaking the rule. */
async function runCheck(id: string, command: string, target: RuleTarget, facts?: RunFacts): Promise<RuleResult> {
  const fail = (error: string): RuleResult => ({ id, ok: false, rows: [], error });
  let result;
  try {
    result = await runScript(command, {
      cwd: target.cwd,
      env: { ...databaseEnv(target.database), ...target.env, WINDTUNNEL_RULE: id },
      input: JSON.stringify(facts ?? { requests: [], pages: [] }),
      timeoutMs: CHECK_TIMEOUT_MS,
    });
  } catch (err) {
    return fail(`could not run ${command}: ${(err as Error).message}`);
  }
  const tail = result.stderr.trim().split("\n").slice(-5).join("\n");
  if (result.timedOut) return fail(`check timed out after ${CHECK_TIMEOUT_MS / 1000} s${tail ? `: ${tail}` : ""}`);
  if (result.code !== 0) return fail(`check exited with ${result.code}${tail ? `: ${tail}` : ""}`);
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows: Record<string, unknown>[] = [];
  for (const [i, line] of lines.entries()) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return fail(`check printed a line that isn't JSON (line ${i + 1}: ${line.slice(0, 120)}); print one JSON object per broken row, and log to stderr`);
    }
    rows.push(row !== null && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : { value: row });
  }
  return { id, ok: rows.length === 0, rows: rows.slice(0, MAX_ROWS) };
}

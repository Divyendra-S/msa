import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "./config.ts";
import type { Project } from "./project.ts";

export const RULES_FILE = "rules.yaml";
const MAX_ROWS = 20;

const RuleSchema = z.object({
  description: z.string().optional(),
  /** A query that lists the rows breaking the rule. */
  sql: z.string(),
  expect: z.literal("empty").default("empty"),
});

const RulesFileSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "rule ids are lower-case-with-dashes"), RuleSchema);

export type Rule = { id: string } & z.infer<typeof RuleSchema>;

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
  return Object.entries(result.data).map(([id, rule]) => ({ id, ...rule }));
}

/** Loads `.windtunnel/rules.yaml`; a project without one has no rules. */
export async function loadRules(project: Project): Promise<Rule[]> {
  const path = join(project.stateDir, RULES_FILE);
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? [] : parseRules(text, path);
}

/**
 * Runs each rule's query read-only against a database. Rules that read run facts see `facts`
 * (empty tables without them, e.g. on the seed data).
 */
export async function checkRules(databaseUrl: string, rules: Rule[], facts?: RunFacts): Promise<RuleResult[]> {
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

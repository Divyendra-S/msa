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

/** Runs each rule's query read-only against a database. */
export async function checkRules(databaseUrl: string, rules: Rule[]): Promise<RuleResult[]> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: "windtunnel-rules" });
  // A dropped connection fails the running query; without a listener it would crash the process.
  client.on("error", () => undefined);
  await client.connect();
  try {
    await client.query("SET statement_timeout = '5s'");
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

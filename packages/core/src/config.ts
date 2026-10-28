import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_FILE = "windtunnel.config.yaml";

const AppSchema = z.object({
  /** Installs dependencies in a fresh worktree. Detected from the lockfile when omitted. */
  install: z.string().optional(),
  build: z.string().optional(),
  start: z.string(),
  baseUrl: z.string().default("http://127.0.0.1:$PORT"),
  /** Path polled after start until it answers with a status below 500. */
  ready: z.string().default("/"),
  readyTimeoutMs: z.number().int().positive().default(60_000),
  env: z.record(z.string(), z.string()).default({}),
  /** The project's own tests, part of a proof's regression set. Run in each version's worktree with $DATABASE_URL on a fresh seed copy. */
  test: z.string().optional(),
  testTimeoutMs: z.number().int().positive().default(600_000),
});

const DbSchema = z.object({
  kind: z.literal("postgres"),
  /** Any URL on the Postgres server to use. Wind Tunnel creates its own databases there. */
  url: z.string(),
  /** Creates schema and seed data in $DATABASE_URL. Runs once per code version to build the snapshot. */
  seed: z.string(),
  /** Log the app's SQL through a local proxy, for the trace chain (off for servers that need TLS). */
  sqlLog: z.boolean().default(true),
});

const MockPaySchema = z.object({
  webhookPath: z.string(),
  webhookDelayMs: z.number().int().nonnegative().default(250),
  chargeLatencyMs: z.number().int().nonnegative().default(20),
});

const UserSchema = z.object({ email: z.string(), password: z.string() });

const CrawlSchema = z.object({
  /** Users to crawl as, besides an anonymous visitor (default: the first user in `users`). */
  users: z.array(z.string()).optional(),
  maxPages: z.number().int().positive().default(40),
  /** Paths not to visit (regular expressions); logout links are always skipped. */
  skip: z.array(z.string()).default([]),
  /** Pages and API calls slower than these are reported by the free sweep. */
  slowPageMs: z.number().int().positive().default(2_000),
  slowRequestMs: z.number().int().positive().default(1_000),
});

/**
 * Small decisions (a renamed button, why a run failed): rules first, then a small model
 * with a key we set (never the user's agent subscription), then the agent.
 */
const DeciderSchema = z.object({
  /** auto: Muse Spark when MODEL_API_KEY is set, else Jev when OPENROUTER_API_KEY is set, else rules only. */
  use: z.enum(["auto", "rules", "spark", "jev"]).default("auto"),
  /** Answers below this confidence go to the next level. */
  confidence: z.number().min(0).max(1).default(0.8),
  spark: z.object({ model: z.string().default("muse-spark-1.3"), baseUrl: z.string().default("https://api.meta.ai/v1") }).prefault({}),
  jev: z.object({ model: z.string().default("typesafe/jev-1.14"), baseUrl: z.string().default("https://openrouter.ai/api/alpha") }).prefault({}),
});

/** Per job (one agent session with the MCP server, or one day of CLI use). */
const BudgetSchema = z.object({
  /** Estimated tokens of tool output; past it, results start with a warning. */
  tokens: z.number().int().positive().default(150_000),
  /** USD for Level 1 decisions; past it, decisions go to the agent. */
  usd: z.number().nonnegative().default(0.5),
});

export const ConfigSchema = z.object({
  app: AppSchema,
  db: DbSchema,
  mockPay: MockPaySchema.optional(),
  users: z.record(z.string(), UserSchema).default({}),
  parallel: z.number().int().min(1).max(32).default(4),
  crawl: CrawlSchema.prefault({}),
  decider: DeciderSchema.prefault({}),
  budget: BudgetSchema.prefault({}),
});

export type WindtunnelConfig = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export async function loadConfig(path: string): Promise<WindtunnelConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, path);
}

export function parseConfig(text: string, source = CONFIG_FILE): WindtunnelConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${source}: invalid config\n${issues.join("\n")}`);
  }
  return result.data;
}

/**
 * Replaces `$NAME` and `${NAME}` with values from `vars`. Unknown names are left
 * untouched so a shell can still expand them. `$$` produces a literal `$`.
 */
export function expandVars(input: string, vars: Record<string, string | undefined>): string {
  return input.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
    if (match === "$$") return "$";
    const value = vars[(braced ?? bare) as string];
    return value ?? match;
  });
}

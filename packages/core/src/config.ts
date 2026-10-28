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
});

const DbSchema = z.object({
  kind: z.literal("postgres"),
  /** Any URL on the Postgres server to use. Wind Tunnel creates its own databases there. */
  url: z.string(),
  /** Creates schema and seed data in $DATABASE_URL. Runs once per code version to build the snapshot. */
  seed: z.string(),
});

const MockPaySchema = z.object({
  webhookPath: z.string(),
  webhookDelayMs: z.number().int().nonnegative().default(250),
  chargeLatencyMs: z.number().int().nonnegative().default(20),
});

const UserSchema = z.object({ email: z.string(), password: z.string() });

export const ConfigSchema = z.object({
  app: AppSchema,
  db: DbSchema,
  mockPay: MockPaySchema.optional(),
  users: z.record(z.string(), UserSchema).default({}),
  parallel: z.number().int().min(1).max(32).default(4),
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

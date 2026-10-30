import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const CONFIG_FILE = "windtunnel.config.yaml";

/** What kind of app this is. `web`, `tauri` and `android` run today; the others are planned (platforms-plan.md). */
export const APP_KINDS = ["web", "tauri", "android", "ios", "mac"] as const;
export type AppKind = (typeof APP_KINDS)[number];

const AppSchema = z.object({
  kind: z.enum(APP_KINDS).default("web"),
  /**
   * The server's folder, relative to this file: where install, build, start, test and the seed
   * run. For a phone app whose server lives elsewhere in the repository (`../server`).
   */
  dir: z
    .string()
    .default(".")
    .refine((d) => !d.startsWith("/"), "a path relative to windtunnel.config.yaml"),
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
  /**
   * Point $HOME at the run's own data folder ($DATA_DIR), for apps that keep files under the
   * user's home (`~/Library/Application Support/<id>`). Every run starts with it empty.
   * Default: on for Tauri apps, off for web apps.
   */
  isolateHome: z.boolean().optional(),
}).transform((app) => ({ ...app, isolateHome: app.isolateHome ?? app.kind === "tauri" }));

const PostgresSchema = z.object({
  kind: z.literal("postgres"),
  /** Any URL on the Postgres server to use. Wind Tunnel creates its own databases there. */
  url: z.string(),
  /** Creates schema and seed data in $DATABASE_URL. Runs once per code version to build the snapshot. */
  seed: z.string(),
  /** Log the app's SQL through a local proxy, for the trace chain (off for servers that need TLS). */
  sqlLog: z.boolean().default(true),
});

const SqliteSchema = z.object({
  kind: z.literal("sqlite"),
  /**
   * The database file, relative to the run's data folder ($DATA_DIR). The app gets its full
   * path as $DATABASE_PATH (and `file:<path>` as $DATABASE_URL).
   */
  file: z
    .string()
    .default("app.db")
    .refine((f) => !f.startsWith("/") && !f.split("/").includes(".."), "a path inside the data folder, without .."),
  /** Creates schema and seed data in $DATABASE_PATH. Runs once per code version to build the snapshot. */
  seed: z.string(),
});

const DbSchema = z.discriminatedUnion("kind", [PostgresSchema, SqliteSchema]);

const MockPaySchema = z.object({
  webhookPath: z.string(),
  webhookDelayMs: z.number().int().nonnegative().default(250),
  chargeLatencyMs: z.number().int().nonnegative().default(20),
});

/** The app on an Android phone (app.kind: android); `app` is then the server it talks to. */
const AndroidSchema = z.object({
  /** The Android project's folder, relative to this file. */
  dir: z
    .string()
    .default(".")
    .refine((d) => !d.startsWith("/"), "a path relative to windtunnel.config.yaml"),
  /** Builds the APK, in `dir` of each code version. A build is reused while that folder's code is unchanged. */
  build: z.string().default("./gradlew --quiet assembleDebug"),
  /** The built APK, relative to `dir`. */
  apk: z.string().default("app/build/outputs/apk/debug/app-debug.apk"),
  /** The application id. */
  package: z.string(),
  /** The activity to launch (`.MainActivity` is in the app's package). */
  activity: z.string().default(".MainActivity"),
  /** Launch extras (`am start --es`). `$BASE_URL` is where the phone reaches the server: http://127.0.0.1:<port>. */
  extras: z.record(z.string(), z.string()).default({}),
  /** The emulator's AVD; `windtunnel devices create` makes `windtunnel-34`. */
  avd: z.string().default("windtunnel-34"),
  /** Emulators running at once, at most: each takes about 2 GB of memory. A run takes one per user. */
  devices: z.number().int().min(1).max(4).default(2),
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

/**
 * The viewer's Run hunt button: a headless Muse Code run, billed to the Meta key (MODEL_API_KEY)
 * in the shell that started the viewer. Never a Claude or Codex login.
 */
const HuntSchema = z.object({
  /** The command; the prompt is added as its last argument. */
  command: z.array(z.string()).min(1).default(["muse", "exec", "--json", "--disable-approval", "--max-model-steps", "80"]),
  /** The hunt skill as the host names it (Muse Code: installed with the windtunnel- prefix). */
  skill: z.string().default("windtunnel-hunt"),
});

export const ConfigSchema = z.object({
  app: AppSchema,
  android: AndroidSchema.optional(),
  /** Optional: an app without a database is checked by `check:` rules and what users saw. */
  db: DbSchema.optional(),
  mockPay: MockPaySchema.optional(),
  users: z.record(z.string(), UserSchema).default({}),
  parallel: z.number().int().min(1).max(32).default(4),
  crawl: CrawlSchema.prefault({}),
  decider: DeciderSchema.prefault({}),
  budget: BudgetSchema.prefault({}),
  hunt: HuntSchema.prefault({}),
});

export type WindtunnelConfig = z.infer<typeof ConfigSchema>;
export type AndroidConfig = z.infer<typeof AndroidSchema>;

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
  const { app, android } = result.data;
  if (app.kind === "android" && !android) {
    throw new ConfigError(`${source}: app.kind android needs an \`android:\` section (at least \`package:\`, the application id)`);
  }
  if (android && app.kind !== "android") throw new ConfigError(`${source}: \`android:\` is for app.kind android`);
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

import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type Branch,
  CONFIG_FILE,
  ConfigError,
  type CodeVersionSpec,
  drillDown,
  formatUsage,
  listUsage,
  loadRules,
  matchesRequest,
  parseRequestPattern,
  Runner,
  UsageMeter,
} from "@windtunnel/core";
import { buildAppMap, crawlDrillDown, Decider, DecisionStore, formatDecision, readCrawl } from "@windtunnel/explorer";

/**
 * The project the server works on, opened on first use: the runner, branches started by
 * hand, and a request → handler lookup for evidence.
 */
export class Workspace {
  private readonly cwd: string;
  private runner?: Promise<Runner>;
  private usage?: UsageMeter;
  readonly branches = new Map<string, Branch>();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  open(): Promise<Runner> {
    this.runner ??= findProjectDir(this.cwd).then((dir) => Runner.open(dir));
    // A failed open (no config yet) is retried on the next call.
    this.runner.catch(() => (this.runner = undefined));
    return this.runner;
  }

  /** This session's usage meter: one job per MCP session. */
  async meter(): Promise<UsageMeter> {
    this.usage ??= UsageMeter.forSession((await this.open()).project.stateDir);
    return this.usage;
  }

  async decider(): Promise<Decider> {
    return Decider.forProject((await this.open()).project, await this.meter());
  }

  async decisions(): Promise<DecisionStore> {
    return new DecisionStore((await this.open()).project.stateDir);
  }

  async close(): Promise<void> {
    await Promise.all([...this.branches.values()].map((b) => b.stop().catch(() => undefined)));
    this.branches.clear();
    if (this.runner) await (await this.runner.catch(() => undefined))?.close();
  }

  /** Request → handler file, from the routes in the code. */
  async handlerResolver(): Promise<(method: string, path: string) => string | undefined> {
    const runner = await this.open();
    const map = await buildAppMap(runner.project);
    const routes = map.routes
      .filter((r) => r.path.startsWith("/"))
      .map((r) => ({ pattern: parseRequestPattern(`${r.method === "ANY" ? "*" : r.method} ${r.path}`), file: r.file }))
      // Literal paths before parameterised ones: /api/orders/new before /api/orders/:id.
      .sort((a, b) => a.pattern.text.split(/[:*]/).length - b.pattern.text.split(/[:*]/).length);
    // A Tauri command call is logged as `INVOKE <command>`.
    const commands = new Map(map.routes.filter((r) => r.method === "INVOKE").map((r) => [r.path, r.file]));
    return (method, path) =>
      method === "INVOKE" ? commands.get(path) : routes.find((r) => matchesRequest(r.pattern, method, `http://x${path}`))?.file;
  }

  /** The app map from the code, and the newest live crawl if there is one. */
  async appMap() {
    const runner = await this.open();
    const version = await runner.branches.versions.resolve({});
    const [map, crawl] = await Promise.all([buildAppMap(runner.project), readCrawl(runner.project, version)]);
    return { map, crawl };
  }

  /**
   * Evidence by handle: a run (`<run>[/<n>/<part>]`), the live crawl (`crawl`, `crawl:<path>`, `sweep`),
   * `usage` or `decisions`.
   */
  async evidence(handle: string): Promise<string> {
    const runner = await this.open();
    const h = handle.trim();
    if (h === "sweep" || h === "crawl" || h.startsWith("crawl:")) {
      const version = await runner.branches.versions.resolve({});
      const found = await readCrawl(runner.project, version);
      if (!found) return "no crawl yet: windtunnel_map with crawl=true runs one";
      return `${found.stale ? `(crawled at version ${found.version.id}; the app's code changed since)\n` : ""}${crawlDrillDown(found, h)}`;
    }
    if (h === "usage") {
      const meter = await this.meter();
      const { budget } = runner.project.config;
      const byTool = new Map<string, { calls: number; tokens: number }>();
      for (const e of meter.list()) {
        if (e.kind !== "tool") continue;
        const t = byTool.get(e.name) ?? { calls: 0, tokens: 0 };
        byTool.set(e.name, { calls: t.calls + 1, tokens: t.tokens + (e.tokens ?? 0) });
      }
      const others = (await listUsage(runner.project.stateDir, 6)).filter((t) => t.job !== meter.job);
      return [
        formatUsage(meter.totals(), budget),
        ...[...byTool].map(([name, t]) => `  ${name.padEnd(20)} ${String(t.calls).padStart(3)} call(s) ≈ ${t.tokens} tokens`),
        `Level 1: ${(await this.decider()).level}`,
        ...(others.length ? ["Earlier jobs:", ...others.map((t) => `  ${formatUsage(t)}`)] : []),
      ].join("\n");
    }
    if (h === "decisions") {
      const open = await (await this.decisions()).open();
      return open.length ? open.map(formatDecision).join("\n\n") : "no open decisions";
    }
    return drillDown(runner.store, h, {
      rules: await this.rules(),
      handlerFor: await this.handlerResolver().catch(() => undefined),
      source: runner.project,
    });
  }

  async rules() {
    return loadRules((await this.open()).project).catch(() => []);
  }

  /** `{ref, patch}` from tool input; `patch` is a diff or a path to one (relative to the project). */
  async versionSpec(input: { ref?: string; patch?: string }): Promise<CodeVersionSpec> {
    const runner = await this.open();
    let patch = input.patch;
    if (patch && !/^(diff --git|--- |Index: )/m.test(patch.trimStart().split("\n")[0] ?? "")) {
      const path = isAbsolute(patch) ? patch : resolve(runner.project.root, patch);
      patch = await readFile(path, "utf8").catch(() => {
        throw new ConfigError(`patch: not a unified diff and no file at ${path}`);
      });
    }
    return { ...(input.ref ? { ref: input.ref } : {}), ...(patch ? { patch } : {}) };
  }
}

/**
 * The folder with windtunnel.config.yaml: `cwd` or a parent, else the only one in a
 * subfolder (up to three levels down, e.g. an app inside a monorepo).
 */
export async function findProjectDir(cwd: string): Promise<string> {
  for (let dir = resolve(cwd); ; dir = resolve(dir, "..")) {
    if (await readFile(join(dir, CONFIG_FILE)).then(() => true, () => false)) return dir;
    if (resolve(dir, "..") === dir) break;
  }
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name === CONFIG_FILE) found.push(dir);
      else if (entry.isDirectory() && depth < 3 && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  };
  await walk(resolve(cwd), 0);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) {
    throw new ConfigError(`several ${CONFIG_FILE} files under ${cwd}: ${found.join(", ")}. Start the server with --cwd <app folder>.`);
  }
  throw new ConfigError(`no ${CONFIG_FILE} in ${cwd}, its parents or subfolders. Use the init skill to create one.`);
}

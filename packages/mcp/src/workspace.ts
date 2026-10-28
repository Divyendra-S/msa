import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type Branch,
  CONFIG_FILE,
  ConfigError,
  type CodeVersionSpec,
  loadRules,
  matchesRequest,
  parseRequestPattern,
  Runner,
} from "@windtunnel/core";
import { buildAppMap } from "@windtunnel/explorer";

/**
 * The project the server works on, opened on first use: the runner, branches started by
 * hand, and a request → handler lookup for evidence.
 */
export class Workspace {
  private readonly cwd: string;
  private runner?: Promise<Runner>;
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
    return (method, path) => routes.find((r) => matchesRequest(r.pattern, method, `http://x${path}`))?.file;
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

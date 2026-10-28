import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  changedFiles,
  type Experiment,
  type ExperimentResult,
  experimentInputs,
  formatResults,
  loadRules,
  matchesRequest,
  parseRequestPattern,
  type Project,
  type Runner,
} from "@windtunnel/core";
import { findNextRoutes, type RouteFile } from "./routes.ts";
import { SourceIndex } from "./source.ts";

export interface AffectedEntry {
  experiment: string;
  /** cached: its last result still holds · affected: code it uses changed · new: no result to reuse. */
  status: "cached" | "affected" | "new";
  reason: string;
  /** The result that still holds (cached), or the last one (affected). */
  last?: ExperimentResult;
}

const SPECIAL = /^(layout|template|loading|error|not-found|default|global-error)\.(tsx?|jsx?)$/;
const ROUTE_FILE = /^(route|page|layout|template|loading|error|not-found|default|global-error)\.(tsx?|jsx?|mjs)$/;
const SOURCE = /\.(tsx?|jsx?|mjs|cjs)$/;
const NOT_RUNTIME = [
  /\.(md|mdx|txt)$/i,
  /(^|\/)(LICENSE|CHANGELOG|README)[^/]*$/i,
  /(^|\/)(docs?|__tests__|tests?|e2e|cypress|\.github|\.vscode)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
];
const ENTRY_FILES = ["middleware", "instrumentation", "proxy"].flatMap((n) => [n, `src/${n}`]).flatMap((n) => [".ts", ".js"].map((e) => n + e));

/**
 * Which experiments need running after the code changed: each experiment's last good result
 * is reused while none of the files it used changed. Its files are the route handlers and
 * pages its requests reached (with layouts and middleware), every local module they load,
 * and anything that is not app code (dependencies, config, seed, schema).
 */
export async function findAffected(runner: Runner, experiments: Experiment[], options: { repeat?: number } = {}): Promise<AffectedEntry[]> {
  const project = runner.project;
  const version = await runner.branches.versions.resolve({});
  const rules = await loadRules(project);
  const graph = await AppGraph.build(project);
  const index = await runner.store.list(Number.MAX_SAFE_INTEGER);
  const results = new Map<string, Promise<ExperimentResult | undefined>>();
  const read = (id: string) => {
    let r = results.get(id);
    if (!r) results.set(id, (r = runner.store.read(id).then((x) => x as ExperimentResult, () => undefined)));
    return r;
  };
  const diffs = new Map<string, Promise<{ status: "A" | "D" | "M"; path: string }[] | undefined>>();
  const diff = (tree: string) => {
    let d = diffs.get(tree);
    if (!d) diffs.set(tree, (d = changedFiles(project.repoRoot, tree, version.tree).catch(() => undefined)));
    return d;
  };

  const out: AffectedEntry[] = [];
  for (const experiment of experiments) {
    const inputs = await experimentInputs(project, experiment, rules);
    const repeat = options.repeat ?? experiment.repeat;
    // The newest usable result, preferring one on exactly this code (a proof's runs on other versions come later).
    let last: ExperimentResult | undefined;
    for (const entry of index) {
      if (entry.experiment !== experiment.id || entry.outcome === "error") continue;
      const r = await read(entry.id);
      if (!r?.inputs || r.inputs !== inputs || !r.version.tree || !r.touched) continue;
      if (Math.min(...r.variants.map((v) => v.runs)) < repeat) continue;
      last ??= r;
      if (r.version.tree === version.tree) {
        last = r;
        break;
      }
    }
    if (!last) {
      const ran = index.some((e) => e.experiment === experiment.id);
      out.push({
        experiment: experiment.id,
        status: "new",
        reason: ran ? `no finished run with this experiment, flow and rules at ${repeat}+ runs per ordering` : "never run",
      });
      continue;
    }
    const where = `run ${last.runId}, version ${last.version.id}`;
    if (last.version.tree === version.tree) {
      out.push({ experiment: experiment.id, status: "cached", reason: `same code as ${where}`, last });
      continue;
    }
    const changes = await diff(last.version.tree!);
    if (!changes) {
      out.push({ experiment: experiment.id, status: "affected", reason: `the code of ${where} is no longer in git`, last });
      continue;
    }
    const uses = await graph.closure(last.touched!);
    const hits = graph.relevant(changes, uses);
    out.push(
      hits.length
        ? { experiment: experiment.id, status: "affected", reason: `changed since ${where}: ${list(hits)}`, last }
        : { experiment: experiment.id, status: "cached", reason: `none of its ${uses.size} files changed since ${where}`, last },
    );
  }
  return out;
}

export function formatAffected(entries: AffectedEntry[]): string {
  const width = Math.max(...entries.map((e) => e.experiment.length), 10);
  return entries
    .map((e) => {
      const outcome = e.last ? ` (last: ${e.last.outcome.toUpperCase()})` : "";
      return `${e.experiment.padEnd(width)}  ${e.status.padEnd(8)}  ${e.reason}${e.status === "cached" ? `: ${e.last!.outcome.toUpperCase()}` : outcome}`;
    })
    .join("\n");
}

/** After `run --affected`: why each experiment ran, the results, and the results reused. */
export function formatAffectedRun(entries: AffectedEntry[], results: ExperimentResult[], cwd?: string): string {
  const ran = entries.filter((e) => e.status !== "cached");
  const cached = entries.filter((e) => e.status === "cached");
  const width = Math.max(10, ...entries.map((e) => e.experiment.length));
  const lines: string[] = [];
  if (ran.length) {
    lines.push(`ran ${ran.length} of ${entries.length} experiment(s):`, ...ran.map((e) => `  ${e.experiment.padEnd(width)}  ${e.status === "new" ? `new: ${e.reason}` : e.reason}`), "", formatResults(results, cwd));
  } else {
    lines.push(`nothing to run: no experiment uses code that changed`);
  }
  if (cached.length) {
    lines.push(
      "",
      `reused ${cached.length} result(s), no change in the code they use:`,
      ...cached.map((e) => `  ${e.experiment.padEnd(width)}  ${e.last!.outcome.toUpperCase().padEnd(5)}  run ${e.last!.runId} (${e.reason})`),
    );
  }
  return lines.join("\n");
}

function list(items: string[]): string {
  return items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`;
}

/** The app's routes and module graph, from the files in the working tree. */
class AppGraph {
  private readonly project: Project;
  private readonly index: SourceIndex;
  private readonly routes: { pattern: ReturnType<typeof parseRequestPattern>; route: RouteFile }[];
  private readonly entries: string[];
  private readonly workspaceDeps: boolean;
  /** Every module reachable from a route, page or middleware. */
  private modules = new Set<string>();

  private constructor(project: Project, routes: RouteFile[], entries: string[], workspaceDeps: boolean) {
    this.project = project;
    this.index = new SourceIndex(project.root);
    this.entries = entries;
    this.workspaceDeps = workspaceDeps;
    this.routes = routes
      .filter((r) => r.path.startsWith("/"))
      .map((route) => ({ pattern: parseRequestPattern(`* ${route.path}`), route }))
      // Literal paths before parameterised ones: /api/orders/new before /api/orders/:id.
      .sort((a, b) => a.pattern.text.split(/[:*]/).length - b.pattern.text.split(/[:*]/).length);
  }

  static async build(project: Project): Promise<AppGraph> {
    const { routes } = await findNextRoutes(project.root);
    const entries: string[] = [];
    for (const name of ENTRY_FILES) {
      const file = join(project.root, name);
      if (await readFile(file).then(() => true, () => false)) entries.push(file);
    }
    const pkg = await readFile(join(project.root, "package.json"), "utf8").catch(() => "");
    const graph = new AppGraph(project, routes, entries, /"workspace:/.test(pkg));
    graph.modules = await graph.reach([...routes.map((r) => r.file), ...entries]);
    return graph;
  }

  /** Files an experiment used: what handled its requests, and everything they load. */
  async closure(touched: string[]): Promise<Set<string>> {
    const start = new Set(this.entries);
    for (const request of touched) {
      const [method = "GET", path = "/"] = request.split(" ");
      const url = `http://x${path}`;
      // An API route for this path, else the page (server actions post to the page's path).
      const api = this.routes.find((r) => (r.route.kind === "app" || r.route.kind === "pages-api") && matchesRequest(r.pattern, method, url));
      const page = api ? undefined : this.routes.find((r) => r.route.kind === "page" && matchesRequest(r.pattern, "GET", url));
      const hit = api ?? page;
      if (!hit) continue;
      start.add(hit.route.file);
      if (page) for (const f of await this.pageFrame(page.route.file)) start.add(f);
    }
    return this.reach([...start]);
  }

  /** Changed files that matter for an experiment that used `uses` (paths relative to the app). */
  relevant(changes: { status: "A" | "D" | "M"; path: string }[], uses: Set<string>): string[] {
    const hits: string[] = [];
    const prefix = this.project.appSubdir ? `${this.project.appSubdir.split(sep).join("/")}/` : "";
    for (const { status, path } of changes) {
      const file = join(this.project.repoRoot, path);
      const inApp = path.startsWith(prefix);
      const rel = inApp ? path.slice(prefix.length) : path;
      if (NOT_RUNTIME.some((p) => p.test(rel))) continue;
      if (uses.has(file)) {
        hits.push(rel);
      } else if (!inApp) {
        // Outside the app: root files (lockfile, workspace config) count; other packages only if the app depends on them.
        if (!path.includes("/") || this.workspaceDeps) hits.push(path);
      } else if (this.modules.has(file)) {
        continue; // app code this experiment never reached
      } else if (ROUTE_FILE.test(basename(rel)) || /^(src\/)?pages\//.test(rel) || ENTRY_FILES.includes(rel)) {
        if (status !== "M") hits.push(`${rel} (route ${status === "A" ? "added" : "removed"})`);
      } else if (SOURCE.test(rel) && status !== "M" && !/\.config\.[cm]?[jt]s$/.test(rel)) {
        continue; // a module nothing loads (yet), or one no longer loaded
      } else {
        hits.push(rel); // config, scripts, seed, schema, dependencies, assets
      }
    }
    return hits;
  }

  /** Layouts, templates and boundaries that wrap an App Router page; _app/_document for the Pages Router. */
  private async pageFrame(pageFile: string): Promise<string[]> {
    const out: string[] = [];
    const rel = relative(this.project.root, pageFile).split(sep);
    const routerRoot = rel[0] === "src" ? join(this.project.root, "src", rel[1]!) : join(this.project.root, rel[0]!);
    if (rel.includes("pages") && !rel.includes("app")) {
      for (const name of ["_app", "_document"]) {
        for (const ext of [".tsx", ".ts", ".jsx", ".js"]) {
          const f = join(routerRoot, name + ext);
          if (await readFile(f).then(() => true, () => false)) out.push(f);
        }
      }
      return out;
    }
    for (let dir = dirname(pageFile); dir.startsWith(routerRoot); dir = dirname(dir)) {
      for (const name of await readdir(dir).catch(() => [] as string[])) if (SPECIAL.test(name)) out.push(join(dir, name));
      if (dir === routerRoot) break;
    }
    return out;
  }

  private async reach(start: string[]): Promise<Set<string>> {
    const seen = new Set<string>();
    const queue = [...start];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (SOURCE.test(file)) queue.push(...(await this.index.dependencies(file)));
    }
    return seen;
  }
}

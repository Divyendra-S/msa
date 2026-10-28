import { createHash } from "node:crypto";
import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { CONFIG_FILE, ConfigError, loadConfig, type WindtunnelConfig } from "./config.ts";
import { repoRoot } from "./git.ts";

export interface Project {
  /** Folder that holds windtunnel.config.yaml (the app). */
  root: string;
  configPath: string;
  config: WindtunnelConfig;
  /** Top level of the git repository that contains the app. */
  repoRoot: string;
  /** `root` relative to `repoRoot` ("" when they are the same). */
  appSubdir: string;
  /** Short stable id for this project, used in database names. */
  key: string;
  /** `<root>/.windtunnel`: flows, experiments, rules, runs, logs. */
  stateDir: string;
  /** Per-project cache outside the repo: worktrees and builds. */
  cacheDir: string;
}

/** Finds windtunnel.config.yaml in `cwd` or a parent folder and loads it. */
export async function openProject(cwd = process.cwd()): Promise<Project> {
  const configPath = await findUp(await realpath(cwd), CONFIG_FILE);
  if (!configPath) throw new ConfigError(`no ${CONFIG_FILE} found in ${cwd} or its parent folders`);
  const root = dirname(configPath);
  const config = await loadConfig(configPath);
  const top = await realpath(await repoRoot(root)).catch(() => {
    throw new ConfigError(`${root} is not inside a git repository; Wind Tunnel needs git to create isolated code versions`);
  });
  const key = createHash("sha256").update(root).digest("hex").slice(0, 6);
  const cacheBase = process.env.WINDTUNNEL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "windtunnel");
  const project: Project = {
    root,
    configPath,
    config,
    repoRoot: top,
    appSubdir: relative(top, root),
    key,
    stateDir: join(root, ".windtunnel"),
    cacheDir: join(cacheBase, `${basename(root)}-${key}`),
  };
  await ensureStateDir(project);
  return project;
}

const STATE_GITIGNORE = `# Wind Tunnel local state. Flows, experiments and rules.yaml are meant to be committed.
runs/
logs/
pids/
cache/
`;

async function ensureStateDir(project: Project): Promise<void> {
  await mkdir(project.stateDir, { recursive: true });
  const ignore = join(project.stateDir, ".gitignore");
  if (!(await exists(ignore))) await writeFile(ignore, STATE_GITIGNORE);
}

async function findUp(start: string, name: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

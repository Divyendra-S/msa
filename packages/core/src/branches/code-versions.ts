import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, posix, sep } from "node:path";
import { findAndroidSdk } from "../android/sdk.ts";
import { sh } from "../exec.ts";
import { addWorktree, commitPatch, git, removeWorktree, resolveRef, snapshotWorkingTree, withoutPaths } from "../git.ts";
import { withLock } from "../lock.ts";
import { exists, type Project } from "../project.ts";

/**
 * Which code to run. Without `ref`, the current working tree is used, including
 * uncommitted and untracked files. `patch` (a unified diff) is applied on top.
 */
export interface CodeVersionSpec {
  ref?: string;
  patch?: string;
  label?: string;
}

export interface CodeVersion {
  /** Short git tree id: identical code always gets the same id. */
  id: string;
  commit: string;
  tree: string;
  label: string;
  /** The commit it builds on: the ref, or HEAD for the working tree (absent in a repository with no commits). */
  base?: string;
}

export interface PreparedVersion {
  version: CodeVersion;
  /** Worktree root (a checkout of the whole repository). */
  worktree: string;
  /** The server's folder inside the worktree (the app's, unless `app.dir` points elsewhere). */
  appDir: string;
  /** For a phone app: its built APK, shared by every version with the same app code. */
  apk?: string;
}

const READY_MARKER = ".windtunnel-ready.json";

/** Turns code versions into installed, built worktrees, cached by tree id. */
export class CodeVersions {
  private readonly project: Project;
  private readonly inflight = new Map<string, Promise<PreparedVersion>>();
  private readonly apks = new Map<string, Promise<string>>();

  constructor(project: Project) {
    this.project = project;
  }

  get worktreesDir(): string {
    return join(this.project.cacheDir, "worktrees");
  }

  /**
   * Flows, experiments and rules (`.windtunnel/`) are left out of the version: they
   * are read from the working tree, and editing them must not trigger a rebuild.
   */
  async resolve(spec: CodeVersionSpec = {}): Promise<CodeVersion> {
    const root = this.project.repoRoot;
    const exclude = [[this.project.appSubdir, ".windtunnel"].filter(Boolean).join("/").split(sep).join("/")];
    const on = await resolveRef(root, spec.ref ?? "HEAD").then((r) => r.commit, () => undefined);
    let base = spec.ref ? await resolveRef(root, spec.ref) : await snapshotWorkingTree(root, exclude);
    if (spec.patch) base = await commitPatch(root, base.commit, spec.patch);
    if (spec.ref || spec.patch) base = await withoutPaths(root, base, exclude);
    const label = spec.label ?? [spec.ref ?? "working tree", spec.patch ? "+ patch" : ""].filter(Boolean).join(" ");
    return { id: base.tree.slice(0, 12), commit: base.commit, tree: base.tree, label, ...(on ? { base: on } : {}) };
  }

  /** Checks out, installs and builds a version once; later calls reuse it. */
  prepare(version: CodeVersion): Promise<PreparedVersion> {
    let pending = this.inflight.get(version.id);
    if (!pending) {
      pending = this.prepareOnce(version)
        .then(async (prepared) => (this.project.config.android ? { ...prepared, apk: await this.apk(prepared) } : prepared))
        .finally(() => this.inflight.delete(version.id));
      this.inflight.set(version.id, pending);
    }
    return pending;
  }

  get apksDir(): string {
    return join(this.project.cacheDir, "apks");
  }

  /**
   * Builds the phone app of a version, unless a version with the same app code (its folder's
   * git tree) already did: a patch to the server reuses the APK.
   */
  private apk(prepared: PreparedVersion): Promise<string> {
    const android = this.project.config.android!;
    const rel = posix.normalize([this.project.appSubdir.split(sep).join("/"), android.dir].filter(Boolean).join("/"));
    return (async () => {
      const tree = (await git(["rev-parse", `${prepared.version.commit}:${rel === "." ? "" : rel}`], this.project.repoRoot)).trim();
      const apk = join(this.apksDir, `${tree.slice(0, 12)}.apk`);
      let pending = this.apks.get(apk);
      if (!pending) {
        pending = this.buildApk(prepared, apk);
        this.apks.set(apk, pending);
        pending.catch(() => this.apks.delete(apk));
      }
      return pending;
    })();
  }

  private async buildApk(prepared: PreparedVersion, apk: string): Promise<string> {
    if (await exists(apk)) return apk;
    const android = this.project.config.android!;
    await mkdir(this.apksDir, { recursive: true });
    return withLock(`${apk}.lock`, async () => {
      if (await exists(apk)) return apk;
      const dir = join(prepared.worktree, this.project.appSubdir, android.dir);
      const sdk = await findAndroidSdk();
      const env: Record<string, string> = { CI: "1", ...(sdk ? { ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root } : {}) };
      await sh(android.build, { cwd: dir, logFile: this.logFile(prepared.version.id), env });
      await copyFile(join(dir, android.apk), `${apk}.tmp`);
      await rename(`${apk}.tmp`, apk);
      return apk;
    });
  }

  /** Checked-out versions, most recently used first. One still being built counts from when it started. */
  async listByLastUse(): Promise<{ id: string; lastUsed: number }[]> {
    const result: { id: string; lastUsed: number }[] = [];
    for (const id of await this.list()) {
      const info =
        (await stat(join(this.worktreesDir, id, READY_MARKER)).catch(() => undefined)) ??
        (await stat(join(this.worktreesDir, id)).catch(() => undefined));
      result.push({ id, lastUsed: info?.mtimeMs ?? 0 });
    }
    return result.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /** Being prepared, here or in another process (which holds its lock). */
  async isBusy(id: string): Promise<boolean> {
    return this.inflight.has(id) || (await exists(join(this.worktreesDir, `${id}.lock`)));
  }

  async list(): Promise<string[]> {
    if (!(await exists(this.worktreesDir))) return [];
    const entries = await readdir(this.worktreesDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.endsWith(".lock")).map((e) => e.name);
  }

  async remove(id: string): Promise<void> {
    await removeWorktree(this.project.repoRoot, join(this.worktreesDir, id));
  }

  logFile(id: string): string {
    return join(this.project.stateDir, "logs", "versions", `${id}.log`);
  }

  /** Marks a prepared version as just used. False when it is not prepared. */
  private async touch(id: string): Promise<boolean> {
    const now = new Date();
    return utimes(join(this.worktreesDir, id, READY_MARKER), now, now).then(
      () => true,
      () => false,
    );
  }

  private async prepareOnce(version: CodeVersion): Promise<PreparedVersion> {
    const worktree = join(this.worktreesDir, version.id);
    const prepared: PreparedVersion = { version, worktree, appDir: join(worktree, this.project.appSubdir, this.project.config.app.dir) };
    if (await this.touch(version.id)) return prepared;

    await mkdir(this.worktreesDir, { recursive: true });
    return withLock(`${worktree}.lock`, async () => {
      // Another process may have finished it while we waited for the lock.
      if (await exists(join(worktree, READY_MARKER))) return prepared;
      if (await exists(worktree)) await this.remove(version.id);

      const log = this.logFile(version.id);
      const timings: Record<string, number> = {};
      const env: Record<string, string> = { CI: "1" };
      // Rust builds share one target folder, so a new version only recompiles the app's own crates.
      // Each version copies its binary out of it ($CARGO_TARGET_DIR/debug/<name>).
      if (this.project.config.app.kind === "tauri") {
        env.CARGO_TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(this.project.cacheDir, "cargo-target");
      }
      const step = async (name: string, command: string | undefined) => {
        if (!command) return;
        const started = Date.now();
        await sh(command, { cwd: prepared.appDir, logFile: log, env });
        timings[name] = Date.now() - started;
      };

      const started = Date.now();
      await addWorktree(this.project.repoRoot, worktree, version.commit);
      timings.checkout = Date.now() - started;
      await step("install", this.project.config.app.install ?? (await detectInstall(prepared.appDir)));
      await step("build", this.project.config.app.build);

      await writeFile(
        join(worktree, READY_MARKER),
        JSON.stringify({ ...version, preparedAt: new Date().toISOString(), timings }, null, 2),
      );
      return prepared;
    });
  }

  async readMarker(id: string): Promise<(CodeVersion & { timings: Record<string, number> }) | undefined> {
    const text = await readFile(join(this.worktreesDir, id, READY_MARKER), "utf8").catch(() => undefined);
    return text ? JSON.parse(text) : undefined;
  }

  async removeAll(): Promise<number> {
    const ids = await this.list();
    for (const id of ids) await this.remove(id);
    await rm(this.worktreesDir, { recursive: true, force: true });
    return ids.length;
  }
}

async function detectInstall(appDir: string): Promise<string | undefined> {
  const candidates: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile --prefer-offline"],
    ["package-lock.json", "npm ci --prefer-offline --no-audit --no-fund"],
    ["yarn.lock", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
  ];
  for (const [file, command] of candidates) {
    if (await exists(join(appDir, file))) return command;
  }
  return (await exists(join(appDir, "package.json"))) ? "npm install --no-audit --no-fund" : undefined;
}

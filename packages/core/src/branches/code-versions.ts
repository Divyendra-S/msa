import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { findAndroidSdk } from "../android/sdk.ts";
import { sh } from "../exec.ts";
import { addWorktree, commitPatch, git, removeWorktree, resolveRef, snapshotWorkingTree, withoutPaths } from "../git.ts";
import { withLock } from "../lock.ts";
import type { Sanitizer } from "../mac/sanitizer.ts";
import { derivedDataDir, type HostedTests, hostedTests, xcodeBuildCommand } from "../mac/xcode.ts";
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
  /** For a phone app: its build (an APK, or an iOS simulator `.app`), shared by every version with the same app code. */
  phoneApp?: string;
}

/** A version's Mac tests: a Swift package's test bundle, or an Xcode project's app-hosted ones. */
export type MacTests = { kind: "package"; bundle: string } | { kind: "xcode"; hosted: HostedTests[] };

const READY_MARKER = ".windtunnel-ready.json";

/** Turns code versions into installed, built worktrees, cached by tree id. */
export class CodeVersions {
  private readonly project: Project;
  private readonly inflight = new Map<string, Promise<PreparedVersion>>();
  private readonly phoneApps = new Map<string, Promise<string>>();
  private readonly macBuilds = new Map<string, Promise<MacTests>>();

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
        .then(async (prepared) => (this.phoneBuild() ? { ...prepared, phoneApp: await this.phoneApp(prepared) } : prepared))
        .finally(() => this.inflight.delete(version.id));
      this.inflight.set(version.id, pending);
    }
    return pending;
  }

  get phoneAppsDir(): string {
    return join(this.project.cacheDir, "phone-apps");
  }

  /** How this project's phone app is built, if it has one. */
  private phoneBuild(): { dir: string; command: string; ext: "apk" | "app"; output: (dir: string) => Promise<string>; env: () => Promise<Record<string, string>> } | undefined {
    const { android, ios } = this.project.config;
    if (android) {
      return {
        dir: android.dir,
        command: android.build,
        ext: "apk",
        output: async (dir) => join(dir, android.apk),
        env: async (): Promise<Record<string, string>> => {
          const sdk = await findAndroidSdk();
          return sdk ? { ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root } : {};
        },
      };
    }
    if (ios) {
      return {
        dir: ios.dir,
        command: ios.build,
        ext: "app",
        output: async (dir) => (ios.app ? join(dir, ios.app) : findSimulatorApp(join(dir, "build"))),
        env: async () => ({}),
      };
    }
    return undefined;
  }

  /**
   * Builds the phone app of a version, unless a version with the same app code (its folder's
   * git tree) already did: a patch to the server reuses the app.
   */
  private phoneApp(prepared: PreparedVersion): Promise<string> {
    const build = this.phoneBuild()!;
    const rel = posix.normalize([this.project.appSubdir.split(sep).join("/"), build.dir].filter(Boolean).join("/"));
    return (async () => {
      const tree = (await git(["rev-parse", `${prepared.version.commit}:${rel === "." ? "" : rel}`], this.project.repoRoot)).trim();
      const out = join(this.phoneAppsDir, `${tree.slice(0, 12)}.${build.ext}`);
      let pending = this.phoneApps.get(out);
      if (!pending) {
        pending = this.buildPhoneApp(prepared, out);
        this.phoneApps.set(out, pending);
        pending.catch(() => this.phoneApps.delete(out));
      }
      return pending;
    })();
  }

  private async buildPhoneApp(prepared: PreparedVersion, out: string): Promise<string> {
    if (await exists(out)) return out;
    const build = this.phoneBuild()!;
    await mkdir(this.phoneAppsDir, { recursive: true });
    return withLock(`${out}.lock`, async () => {
      if (await exists(out)) return out;
      const dir = join(prepared.worktree, this.project.appSubdir, build.dir);
      await sh(build.command, { cwd: dir, logFile: this.logFile(prepared.version.id), env: { CI: "1", ...(await build.env()) } });
      const built = await build.output(dir);
      await rm(`${out}.tmp`, { recursive: true, force: true });
      if (build.ext === "app") await cp(built, `${out}.tmp`, { recursive: true, verbatimSymlinks: true });
      else await copyFile(built, `${out}.tmp`);
      await rename(`${out}.tmp`, out);
      return out;
    });
  }

  /**
   * A Swift Mac app's tests for a version (app.kind: mac), built once per version and sanitizer:
   * a Swift package's test bundle, by default into its own `.build/windtunnel-<sanitizer>` so
   * builds with and without ThreadSanitizer don't overwrite each other; an Xcode project's
   * app-hosted bundles, into a derived data folder of their own in /tmp.
   */
  macTests(prepared: PreparedVersion, sanitizer: Sanitizer): Promise<MacTests> {
    const key = `${prepared.version.id}:${sanitizer}`;
    let pending = this.macBuilds.get(key);
    if (!pending) {
      pending = this.project.config.mac!.project ? this.buildXcodeTests(prepared, sanitizer) : this.buildMacTests(prepared, sanitizer);
      this.macBuilds.set(key, pending);
      pending.catch(() => this.macBuilds.delete(key));
    }
    return pending;
  }

  private async buildMacTests(prepared: PreparedVersion, sanitizer: Sanitizer): Promise<MacTests> {
    const mac = this.project.config.mac!;
    const dir = join(prepared.worktree, this.project.appSubdir, mac.dir);
    const scratch = `.build/windtunnel-${sanitizer}`;
    const command = mac.build ?? `swift build --build-tests --scratch-path ${scratch}${sanitizer === "thread" ? " --sanitize=thread" : ""}`;
    const marker = join(dir, ".build", `windtunnel-built-${sanitizer}`);
    const bundle = async (): Promise<MacTests> => {
      if (mac.tests) return { kind: "package", bundle: join(dir, mac.tests) };
      const products = join(dir, mac.build ? ".build" : scratch, "debug");
      const found = (await readdir(products).catch(() => [])).filter((f) => f.endsWith(".xctest"));
      if (found.length !== 1) {
        throw new Error(`expected one test bundle in ${products}, found ${found.length ? found.join(", ") : "none"}: set mac.tests`);
      }
      return { kind: "package", bundle: join(products, found[0]!) };
    };
    if (await exists(marker)) return bundle();
    return withLock(`${dir}.mac-${sanitizer}.lock`, async () => {
      if (!(await exists(marker))) {
        await sh(command, { cwd: dir, logFile: this.logFile(prepared.version.id), env: { CI: "1" } });
        await mkdir(dirname(marker), { recursive: true });
        await writeFile(marker, command);
      }
      return bundle();
    });
  }

  private async buildXcodeTests(prepared: PreparedVersion, sanitizer: Sanitizer): Promise<MacTests> {
    const mac = this.project.config.mac!;
    const dir = join(prepared.worktree, this.project.appSubdir, mac.dir);
    const derivedData = derivedDataDir(this.project.key, prepared.version.id, sanitizer);
    const command = mac.build ?? xcodeBuildCommand(mac, sanitizer);
    const marker = join(derivedData, "windtunnel-built");
    const tests = async (): Promise<MacTests> => ({ kind: "xcode", hosted: await hostedTests(derivedData) });
    if (await exists(marker)) return tests();
    await mkdir(dirname(derivedData), { recursive: true });
    return withLock(`${derivedData}.lock`, async () => {
      if (!(await exists(marker))) {
        await sh(command, { cwd: dir, logFile: this.logFile(prepared.version.id), env: { CI: "1", DERIVED_DATA: derivedData } });
        await writeFile(marker, command);
      }
      return tests();
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
    if (this.project.config.mac?.project) {
      for (const sanitizer of ["none", "thread"] as const) await rm(derivedDataDir(this.project.key, id, sanitizer), { recursive: true, force: true });
    }
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

/** The one app an Xcode build for the simulator left under `dir` (`…/Debug-iphonesimulator/Name.app`). */
async function findSimulatorApp(dir: string): Promise<string> {
  const found: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const entry of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const path = join(d, entry.name);
      if (entry.name.endsWith(".app")) {
        if (d.endsWith("-iphonesimulator")) found.push(path);
      } else if (!entry.name.endsWith(".xcarchive") && entry.name !== "Intermediates.noindex") await walk(path, depth + 1);
    }
  };
  await walk(dir, 0);
  if (found.length === 1) return found[0]!;
  throw new Error(
    found.length === 0
      ? `the build left no simulator app in ${dir}: set ios.app to the built .app (relative to ios.dir)`
      : `the build left ${found.length} simulator apps (${found.map((f) => f.slice(dir.length + 1)).join(", ")}): set ios.app to the one to run`,
  );
}

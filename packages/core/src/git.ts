import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Fixed identity and dates make commits we create deterministic: the same tree
// on the same parent always gives the same commit id.
const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "windtunnel",
  GIT_AUTHOR_EMAIL: "windtunnel@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "windtunnel",
  GIT_COMMITTER_EMAIL: "windtunnel@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export class GitError extends Error {
  override name = "GitError";
}

export async function git(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")}: ${(e.stderr || e.message).trim()}`);
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

export interface CommitTree {
  commit: string;
  tree: string;
}

export async function resolveRef(root: string, ref: string): Promise<CommitTree> {
  const commit = await git(["rev-parse", "--verify", `${ref}^{commit}`], root);
  const tree = await git(["rev-parse", `${commit}^{tree}`], root);
  return { commit, tree };
}

/**
 * Captures the working tree (staged, unstaged and untracked files, minus ignored
 * ones and `exclude`d paths) as a commit on top of HEAD. Uses a throwaway index,
 * so the user's index and files are never touched.
 */
export async function snapshotWorkingTree(root: string, exclude: string[] = []): Promise<CommitTree> {
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root).catch(() => "");
  return withTempIndex(async (env, indexPath) => {
    const realIndex = resolvePath(root, await git(["rev-parse", "--git-path", "index"], root));
    // Starting from a copy of the real index lets git skip rehashing unchanged files.
    await copyFile(realIndex, indexPath).catch(() => undefined);
    await git(["add", "--all", "--", "."], root, env);
    if (exclude.length > 0) await git(["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", ...exclude], root, env);
    const tree = await git(["write-tree"], root, env);
    if (head && tree === (await git(["rev-parse", `${head}^{tree}`], root))) return { commit: head, tree };
    const commit = await git(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "windtunnel: working tree snapshot"], root, {
      ...env,
      ...SNAPSHOT_ENV,
    });
    return { commit, tree };
  });
}

/** Applies a unified diff on top of `base` and returns the resulting commit. */
export async function commitPatch(root: string, base: string, patch: string): Promise<CommitTree> {
  return withTempIndex(async (env, indexPath) => {
    const patchFile = `${indexPath}.patch`;
    await writeFile(patchFile, patch.endsWith("\n") ? patch : `${patch}\n`);
    await git(["read-tree", base], root, env);
    await git(["apply", "--cached", "--whitespace=nowarn", patchFile], root, env);
    const tree = await git(["write-tree"], root, env);
    const commit = await git(["commit-tree", tree, "-p", base, "-m", "windtunnel: patched version"], root, {
      ...env,
      ...SNAPSHOT_ENV,
    });
    return { commit, tree };
  });
}

/** The same commit without `paths`; returns `base` itself when none of them are in it. */
export async function withoutPaths(root: string, base: CommitTree, paths: string[]): Promise<CommitTree> {
  if (paths.length === 0) return base;
  return withTempIndex(async (env) => {
    await git(["read-tree", base.tree], root, env);
    await git(["rm", "-r", "--cached", "--ignore-unmatch", "-q", "--", ...paths], root, env);
    const tree = await git(["write-tree"], root, env);
    if (tree === base.tree) return base;
    const commit = await git(["commit-tree", tree, "-p", base.commit, "-m", "windtunnel: without test files"], root, {
      ...env,
      ...SNAPSHOT_ENV,
    });
    return { commit, tree };
  });
}

/** Files that differ between two trees: `A` added, `D` deleted, `M` modified (renames count as both). */
export async function changedFiles(root: string, from: string, to: string): Promise<{ status: "A" | "D" | "M"; path: string }[]> {
  if (from === to) return [];
  const out = await git(["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to], root);
  const parts = out.split("\0").filter(Boolean);
  const files: { status: "A" | "D" | "M"; path: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.charAt(0);
    files.push({ status: status === "A" || status === "D" ? status : "M", path: parts[i + 1]! });
  }
  return files;
}

/** `git diff --stat` between two commits or trees, leaving out `exclude` paths. */
export async function diffStat(root: string, from: string, to: string, exclude: string[] = []): Promise<string> {
  return git(["diff", "--stat=100", from, to, "--", ".", ...exclude.map((p) => `:(exclude)${p}`)], root);
}

/**
 * Creates branch `name` with one commit on top of `parent`: the files of `tree`, the
 * `restore` folder as it is in `parent`, and `files` (repository path → file on disk).
 * Never moves an existing branch, and never touches the working tree or the real index.
 */
export async function createBranchCommit(
  root: string,
  options: { name: string; parent: string; tree: string; restore?: string; files: { path: string; source: string }[]; message: string },
): Promise<string> {
  await git(["check-ref-format", "--branch", options.name], root).catch(() => {
    throw new GitError(`not a valid branch name: ${options.name}`);
  });
  const parent = await git(["rev-parse", "--verify", `${options.parent}^{commit}`], root);
  return withTempIndex(async (env) => {
    await git(["read-tree", options.tree], root, env);
    if (options.restore) {
      const kept = await git(["rev-parse", "--verify", "--quiet", `${parent}:${options.restore}`], root).catch(() => "");
      if (kept) await git(["read-tree", `--prefix=${options.restore}/`, kept], root, env);
    }
    const info: string[] = [];
    for (const f of options.files) {
      const blob = await git(["hash-object", "-w", f.source], root);
      info.push("--cacheinfo", `100644,${blob},${f.path}`);
    }
    if (info.length) await git(["update-index", "--add", ...info], root, env);
    const tree = await git(["write-tree"], root, env);
    const commitArgs = ["commit-tree", tree, "-p", parent, "-m", options.message];
    // The user's own name when git knows it, else a neutral one.
    const { GIT_AUTHOR_DATE: _a, GIT_COMMITTER_DATE: _c, ...identity } = SNAPSHOT_ENV;
    const commit = await git(commitArgs, root, env).catch(() => git(commitArgs, root, { ...env, ...identity }));
    await git(["update-ref", `refs/heads/${options.name}`, commit, ""], root).catch((err: Error) => {
      throw new GitError(/exists|reference already/.test(err.message) ? `branch ${options.name} already exists: pick another name` : err.message);
    });
    return commit;
  });
}

export async function addWorktree(root: string, dir: string, commit: string): Promise<void> {
  await git(["worktree", "add", "--detach", "--force", dir, commit], root);
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(["worktree", "remove", "--force", "--force", dir], root).catch(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await git(["worktree", "prune"], root);
}

export interface WorktreeInfo {
  path: string;
  head: string;
}

export async function listWorktrees(root: string): Promise<WorktreeInfo[]> {
  const out = await git(["worktree", "list", "--porcelain"], root);
  const result: WorktreeInfo[] = [];
  for (const block of out.split("\n\n")) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const head = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1];
    if (path && head) result.push({ path, head });
  }
  return result;
}

async function withTempIndex<T>(fn: (env: Record<string, string>, indexPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "windtunnel-index-"));
  const indexPath = join(dir, "index");
  try {
    return await fn({ GIT_INDEX_FILE: indexPath }, indexPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function resolvePath(root: string, p: string): string {
  return isAbsolute(p) ? p : resolve(root, p);
}

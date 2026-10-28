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
 * ones) as a commit on top of HEAD. Uses a throwaway index, so the user's index
 * and files are never touched.
 */
export async function snapshotWorkingTree(root: string): Promise<CommitTree> {
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root).catch(() => "");
  return withTempIndex(async (env, indexPath) => {
    const realIndex = resolvePath(root, await git(["rev-parse", "--git-path", "index"], root));
    // Starting from a copy of the real index lets git skip rehashing unchanged files.
    await copyFile(realIndex, indexPath).catch(() => undefined);
    await git(["add", "--all", "--", "."], root, env);
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

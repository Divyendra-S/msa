import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { addWorktree, commitPatch, git, removeWorktree, snapshotWorkingTree, withoutPaths } from "../src/git.ts";

describe("git code versions", () => {
  let repo: string;

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "wt-git-")));
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.test");
    run("config", "user.name", "t");
    await writeFile(join(repo, "a.txt"), "one\n");
    await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
    run("add", ".");
    run("commit", "-q", "-m", "init");
  });

  after(() => rm(repo, { recursive: true, force: true }));

  it("returns HEAD when the working tree is clean", async () => {
    const head = await git(["rev-parse", "HEAD"], repo);
    const snap = await snapshotWorkingTree(repo);
    assert.equal(snap.commit, head);
  });

  it("captures uncommitted and untracked files without touching the index", async () => {
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    await writeFile(join(repo, "ignored.txt"), "secret\n");
    const statusBefore = await git(["status", "--porcelain"], repo);

    const snap = await snapshotWorkingTree(repo);
    const again = await snapshotWorkingTree(repo);
    assert.equal(again.commit, snap.commit, "same content gives the same commit");
    assert.equal(await git(["show", `${snap.commit}:a.txt`], repo), "two");
    assert.equal(await git(["show", `${snap.commit}:new.txt`], repo), "new");
    await assert.rejects(git(["show", `${snap.commit}:ignored.txt`], repo));
    assert.equal(await git(["status", "--porcelain"], repo), statusBefore);
  });

  it("applies a patch on top of a commit", async () => {
    const head = await git(["rev-parse", "HEAD"], repo);
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+patched\n";
    const result = await commitPatch(repo, head, patch);
    assert.equal(await git(["show", `${result.commit}:a.txt`], repo), "patched");
    await assert.rejects(commitPatch(repo, head, "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-nope\n+x\n"));
  });

  it("leaves excluded paths out, so editing them keeps the same version", async () => {
    await mkdir(join(repo, "app", ".windtunnel"), { recursive: true });
    await writeFile(join(repo, "app", ".windtunnel", "exp.yaml"), "flow: a\n");
    const exclude = ["app/.windtunnel"];
    const first = await snapshotWorkingTree(repo, exclude);
    await writeFile(join(repo, "app", ".windtunnel", "exp.yaml"), "flow: b\n");
    const second = await snapshotWorkingTree(repo, exclude);
    assert.equal(second.tree, first.tree);
    await assert.rejects(git(["show", `${first.commit}:app/.windtunnel/exp.yaml`], repo));

    const withTests = await snapshotWorkingTree(repo);
    assert.notEqual(withTests.tree, first.tree);
    assert.equal((await withoutPaths(repo, withTests, exclude)).tree, first.tree);
    assert.equal(await withoutPaths(repo, first, exclude), first, "nothing to remove: same commit");
    await rm(join(repo, "app"), { recursive: true, force: true });
  });

  it("checks a snapshot out into a worktree and removes it", async () => {
    const snap = await snapshotWorkingTree(repo);
    const dir = join(repo, "..", `wt-${Date.now()}`);
    await addWorktree(repo, dir, snap.commit);
    assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "new\n");
    await removeWorktree(repo, dir);
    assert.ok(!(await git(["worktree", "list"], repo)).includes(dir));
  });
});

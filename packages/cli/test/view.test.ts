import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { createFixtureRepo } from "../../core/test/fixture.ts";

const BIN = join(import.meta.dirname, "..", "src", "bin.ts");

/** Starts the CLI with stdin as a pipe (as the Mac app does); resolves with its first stdout line. */
function start(args: string[]) {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const first = new Promise<string>((resolve, reject) => {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      lines.push(line);
      if (lines.length === 1) resolve(line);
    });
    child.on("error", reject);
    child.on("close", (code) => reject(new Error(`exited with ${code} before printing`)));
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { child, first, exit, lines };
}

test("view --json prints one line for the Mac app, is reused, and stops when stdin closes", async () => {
  const repo = await createFixtureRepo({});
  const viewer = start(["view", "--json", "--port", "0", "--cwd", repo]);
  try {
    const info = JSON.parse(await viewer.first) as { url: string; port: number; token: string; pid: number; root: string; reused: boolean };
    assert.deepEqual(Object.keys(info), ["url", "port", "token", "pid", "root", "reused"]);
    assert.equal(info.url, `http://127.0.0.1:${info.port}`);
    assert.deepEqual([info.root, info.pid, info.reused], [repo, viewer.child.pid, false]);
    const status = await fetch(`${info.url}/api/status`, { headers: { "x-windtunnel-token": info.token } });
    assert.equal(status.status, 200);
    assert.equal(((await status.json()) as { hunt: { hosts: { claude: { ok: boolean } } } }).hunt.hosts.claude.ok !== undefined, true);

    // A second app window finds it running and gets the same address.
    const again = start(["view", "--json", "--cwd", repo]);
    assert.deepEqual(JSON.parse(await again.first), { ...info, reused: true });
    assert.equal(await again.exit, 0);
    assert.equal(again.lines.length, 1);

    viewer.child.stdin!.end();
    assert.equal(await viewer.exit, 0);
    assert.equal(existsSync(join(repo, ".windtunnel", "cache", "viewer.json")), false);
    assert.equal(viewer.lines.length, 1);
  } finally {
    viewer.child.kill("SIGKILL");
    await rm(repo, { recursive: true, force: true });
  }
});

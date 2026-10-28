// Integration test: needs the development Postgres (`pnpm db:up`). Skipped when it is not reachable.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { Branches } from "../src/branches/branches.ts";
import { PgServer } from "../src/branches/postgres.ts";
import { clean } from "../src/cleanup.ts";

const PG_URL = process.env.WT_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";

const server = (version: string) => `const http = require("node:http");
const { Client } = require(process.env.WT_TEST_PG_MODULE);
const VERSION = "${version}";
http.createServer(async (req, res) => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const { rows } = await db.query("SELECT count(*)::int AS n FROM items");
  await db.end();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ version: VERSION, items: rows[0].n, payments: process.env.PAYMENT_API_URL || null }));
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const seed = `const { Client } = require(process.env.WT_TEST_PG_MODULE);
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL)");
  await db.query("INSERT INTO items (name) VALUES ('a'), ('b')");
  await db.end();
})();
`;

async function pgAvailable(): Promise<boolean> {
  const probe = new PgServer(PG_URL);
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

async function get(url: string): Promise<{ version: string; items: number; payments: string | null }> {
  return (await fetch(url)).json() as Promise<{ version: string; items: number; payments: string | null }>;
}

describe("branches", { skip: !(await pgAvailable()) && "Postgres not reachable (pnpm db:up)" }, () => {
  let repo: string;
  let cache: string;
  let branches: Branches;

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "wt-branches-")));
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    process.env.WINDTUNNEL_CACHE_DIR = cache;
    process.env.WT_TEST_PG_MODULE = createRequire(import.meta.url).resolve("pg");

    await writeFile(join(repo, "server.cjs"), server("v1"));
    await writeFile(join(repo, "seed.cjs"), seed);
    await writeFile(
      join(repo, "windtunnel.config.yaml"),
      `app:
  start: node server.cjs
  env:
    PAYMENT_API_URL: $MOCK_PAY_URL
db:
  kind: postgres
  url: ${PG_URL}
  seed: node seed.cjs
mockPay:
  webhookPath: /hook
parallel: 2
`,
    );
    const run = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.test");
    run("config", "user.name", "t");
    run("add", ".");
    run("commit", "-q", "-m", "init");

    branches = await Branches.open(repo);
  });

  after(async () => {
    await clean(branches, { all: true }).catch(() => undefined);
    await branches?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("runs isolated copies of the app and database, and cleans up on stop", async () => {
    const [a, b] = await Promise.all([branches.create(), branches.create()]);
    assert.equal(a.version.id, b.version.id);
    assert.notEqual(a.port, b.port);
    assert.notEqual(a.database.name, b.database.name);

    const first = await get(a.baseUrl);
    assert.equal(first.version, "v1");
    assert.equal(first.items, 2);
    assert.equal(first.payments, a.payments?.url);

    const db = new pg.Client({ connectionString: a.database.url });
    await db.connect();
    await db.query("INSERT INTO items (name) VALUES ('only in a')");
    await db.end();
    assert.equal((await get(a.baseUrl)).items, 3);
    assert.equal((await get(b.baseUrl)).items, 2, "branch b has its own database");

    // parallel: 2, so a third branch waits for a free slot.
    let thirdReady = false;
    const third = branches.create().then((branch) => {
      thirdReady = true;
      return branch;
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(thirdReady, false);

    await a.stop();
    const c = await third;
    assert.equal(await branches.pg.exists(a.database.name), false, "run database dropped");
    await assert.rejects(fetch(a.baseUrl), "app process stopped");
    await Promise.all([b.stop(), c.stop()]);
  });

  it("runs uncommitted changes and patched versions", async () => {
    await writeFile(join(repo, "server.cjs"), server("v2"));
    const working = await branches.create();
    assert.equal((await get(working.baseUrl)).version, "v2");

    const patch = `--- a/server.cjs
+++ b/server.cjs
@@ -1,4 +1,4 @@
 const http = require("node:http");
 const { Client } = require(process.env.WT_TEST_PG_MODULE);
-const VERSION = "v1";
+const VERSION = "v3";
 http.createServer(async (req, res) => {
`;
    const patched = await branches.create({ ref: "HEAD", patch });
    assert.equal((await get(patched.baseUrl)).version, "v3");
    assert.notEqual(working.version.id, patched.version.id);
    await Promise.all([working.stop(), patched.stop()]);
  });

  it("prunes the least recently used versions, but never one being prepared", async () => {
    const before = await branches.versions.listByLastUse();
    assert.ok(before.length >= 2);
    // A version another process is still building holds its lock.
    const building = before.at(-1)!.id;
    const lock = join(branches.versions.worktreesDir, `${building}.lock`);
    await mkdir(lock);
    await writeFile(join(lock, "pid"), String(process.pid));
    assert.equal(await branches.versions.isBusy(building), true);
    const first = await branches.prune(1, 0);
    assert.ok(!first.includes(building));
    await rm(lock, { recursive: true });

    const removed = [...first, ...(await branches.prune(1, 0))];
    assert.deepEqual(removed.sort(), before.slice(1).map((v) => v.id).sort());
    assert.deepEqual(await branches.versions.list(), [before[0]!.id]);
    assert.equal(await branches.pg.exists(branches.snapshotName(removed[0]!)), false);
  });

  it("clean --all drops snapshots and worktrees", async () => {
    assert.ok((await branches.pg.list(`${branches.dbPrefix}seed_`)).length > 0);
    const result = await clean(branches, { all: true });
    assert.equal(result.worktrees, 1);
    assert.deepEqual(await branches.pg.list(branches.dbPrefix), []);
    assert.deepEqual(await branches.versions.list(), []);
  });
});

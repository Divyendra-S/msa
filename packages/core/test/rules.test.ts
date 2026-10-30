// Rules without Postgres: SQL on a SQLite file, on the run facts alone, and `check:` commands.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ConfigError } from "../src/config.ts";
import { openSqlite } from "../src/database.ts";
import { checkRules, parseRules, type RunFacts } from "../src/rules.ts";

const FACTS: RunFacts = {
  requests: [
    { id: 1, tab: "alice", user_name: "alice", user_email: "a@x.test", step: "pay", method: "POST", path: "/api/orders", query: null, status: 201, failure: null, reached_app: true, at_ms: 10, harness: null },
    { id: 2, tab: "alice", user_name: "alice", user_email: "a@x.test", step: "pay", method: "POST", path: "/api/orders", query: null, status: null, failure: "reset", reached_app: false, at_ms: 20, harness: "answered 503" },
  ],
  pages: [{ tab: "alice", user_name: "alice", user_email: "a@x.test", step: "done", attempt: null, at_ms: 30, path: "/orders/1", text: "Order placed" }],
};

describe("rules", () => {
  let dir: string;
  let path: string;
  let seed: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "wt-rules-"));
    seed = join(dir, "seed.db");
    path = join(dir, "run.db");
    for (const [file, sql] of [
      [seed, "CREATE TABLE products (id INTEGER PRIMARY KEY, stock INT); INSERT INTO products VALUES (1, 5), (2, 1);"],
      [path, "CREATE TABLE products (id INTEGER PRIMARY KEY, stock INT); INSERT INTO products VALUES (1, 3), (2, -1);"],
    ] as const) {
      const db = await openSqlite(file);
      db.exec(sql);
      db.close();
    }
    await writeFile(
      join(dir, "check.mjs"),
      `import { readFileSync } from "node:fs";
const facts = JSON.parse(readFileSync(0, "utf8"));
console.error("checking", process.env.WINDTUNNEL_RULE);
for (const r of facts.requests) if (r.failure) console.log(JSON.stringify({ request: r.id, data: process.env.DATA_DIR, db: process.env.DATABASE_PATH }));
`,
    );
  });

  after(() => rm(dir, { recursive: true, force: true }));

  it("a rule has either sql or check", () => {
    assert.throws(() => parseRules("both:\n  sql: SELECT 1\n  check: node x.js\n"), ConfigError);
    assert.throws(() => parseRules("none:\n  description: nothing to run\n"), /either sql or check/);
    assert.deepEqual(parseRules("files:\n  check: node checks/files.mjs\n"), [{ id: "files", check: "node checks/files.mjs", expect: "empty" }]);
  });

  it("runs SQL rules on a SQLite copy, read-only, with the seed as windtunnel_seed and the run facts", async () => {
    const rules = parseRules(`stock-non-negative:
  sql: SELECT id, stock FROM products WHERE stock < 0
stock-only-goes-down-by-two:
  sql: SELECT p.id, s.stock - p.stock AS sold FROM products p JOIN windtunnel_seed.products s ON s.id = p.id WHERE s.stock - p.stock > 2
lost-orders:
  sql: SELECT id, failure FROM windtunnel_requests WHERE NOT reached_app
shown:
  sql: SELECT path FROM windtunnel_pages WHERE text LIKE '%placed%'
cannot-write:
  sql: DELETE FROM products RETURNING id
`);
    const results = await checkRules({ database: { kind: "sqlite", path, seed }, cwd: dir }, rules, FACTS);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.rows]),
      [
        ["stock-non-negative", false, [{ id: 2, stock: -1 }]],
        ["stock-only-goes-down-by-two", true, []],
        ["lost-orders", false, [{ id: 2, failure: "reset" }]],
        ["shown", false, [{ path: "/orders/1" }]],
        ["cannot-write", false, []],
      ],
    );
    assert.ok(results[4]!.error, "a write is refused");
    const db = await openSqlite(path, { readOnly: true });
    assert.equal((db.prepare("SELECT count(*) AS n FROM products").get() as { n: number }).n, 2);
    db.close();
  });

  it("without a database, SQL rules see only what users got and saw", async () => {
    const rules = parseRules(`one-order:
  sql: SELECT count(*) AS n FROM windtunnel_requests WHERE path = '/api/orders' AND status = 201 HAVING count(*) > 1
app-table:
  sql: SELECT * FROM orders
`);
    const [one, table] = await checkRules({ cwd: dir }, rules, FACTS);
    assert.equal(one!.ok, true);
    assert.match(table!.error!, /no such table: orders.*no database in the config/);
  });

  it("check rules print the broken rows as JSON lines and get the run's state and facts", async () => {
    const rules = parseRules(`lost:
  check: node check.mjs
noisy:
  check: echo not json
crashes:
  check: node -e "console.error('boom'); process.exit(3)"
`);
    const results = await checkRules({ database: { kind: "sqlite", path, seed }, cwd: dir, env: { DATA_DIR: "/data/run" } }, rules, FACTS);
    assert.deepEqual(results[0], { id: "lost", ok: false, rows: [{ request: 2, data: "/data/run", db: path }] });
    assert.match(results[1]!.error!, /isn't JSON \(line 1: not json\)/);
    assert.equal(results[2]!.error, "check exited with 3: boom");
    const [held] = await checkRules({ cwd: dir }, parseRules("lost:\n  check: node check.mjs\n"), { requests: [], pages: [] });
    assert.deepEqual(held, { id: "lost", ok: true, rows: [] });
  });
});

// Integration test: needs the development Postgres (`pnpm db:up`). Skipped when it is not reachable.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { SqlProxy } from "../src/branches/sql-log.ts";
import { attribute, traceLines, writeTarget } from "../src/runner/trace.ts";
import { PG_URL, pgAvailable } from "./fixture.ts";

describe("sql log", { skip: !(await pgAvailable()) && "Postgres not reachable (pnpm db:up)" }, () => {
  let proxy: SqlProxy;

  before(async () => {
    const u = new URL(PG_URL);
    proxy = await SqlProxy.start({ host: u.hostname, port: Number(u.port) });
  });

  after(async () => {
    await proxy.close();
  });

  it("logs statements with parameters, results, errors and transactions", async () => {
    const log = proxy.record("postgres");
    const client = new pg.Client({ connectionString: proxy.urlFor(PG_URL) });
    await client.connect();
    try {
      await client.query("CREATE TEMP TABLE wt_items (id int PRIMARY KEY, name text)");
      const { rows } = await client.query<{ n: number }>("SELECT $1::int + 1 AS n", [41]);
      assert.equal(rows[0]!.n, 42);
      await client.query("BEGIN");
      await client.query("INSERT INTO wt_items (id, name) VALUES ($1, $2)", [1, "a"]);
      await client.query("COMMIT");
      await assert.rejects(client.query("INSERT INTO wt_items (id, name) VALUES ($1, $2)", [1, "again"]), /duplicate key/);
      // The connection still works after an error.
      const after = await client.query("UPDATE wt_items SET name = 'b' WHERE id = 1");
      assert.equal(after.rowCount, 1);
    } finally {
      await client.end();
      log.stop();
    }

    const find = (pattern: RegExp, nth = 0) => log.records.filter((r) => pattern.test(r.sql))[nth];
    assert.equal(find(/SELECT \$1/)?.tag, "SELECT 1");
    assert.deepEqual(find(/SELECT \$1/)?.params, ["41"]);
    const insert = find(/INSERT INTO wt_items/)!;
    assert.equal(insert.tag, "INSERT 0 1");
    assert.equal(insert.tx, true, "ran inside BEGIN … COMMIT");
    assert.equal(find(/^BEGIN/)?.tx, undefined);
    assert.equal(find(/^COMMIT/)?.tx, true);
    const duplicate = find(/INSERT INTO wt_items/, 1)!;
    assert.match(duplicate.error ?? "", /^23505 duplicate key/);
    assert.deepEqual(duplicate.params, ["1", "again"]);
    assert.equal(find(/^UPDATE/)?.tag, "UPDATE 1");
    assert.ok(log.records.every((r) => r.conn === 1 && r.ms >= 0));
  });

  it("passes other databases through without logging them", async () => {
    const log = proxy.record("some_other_database");
    const client = new pg.Client({ connectionString: proxy.urlFor(PG_URL) });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    log.stop();
    assert.equal(log.records.length, 0);
  });

  it("links statements to the request that ran them and renders the trace", () => {
    const statements = [
      { at: 100, ms: 1, conn: 1, sql: "BEGIN" },
      { at: 101, ms: 1, conn: 1, sql: "INSERT INTO orders (cart_id) VALUES ($1)", params: ["5"], tag: "INSERT 0 1", tx: true },
      { at: 102, ms: 1, conn: 1, sql: "COMMIT", tag: "COMMIT", tx: true },
      { at: 150, ms: 1, conn: 2, sql: "UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock >= 1", params: ["3"], tag: "UPDATE 0" },
      { at: 900, ms: 1, conn: 2, sql: "SELECT 1", tag: "SELECT 1" },
      { at: 140, ms: 1, conn: 2, sql: "SELECT stock FROM products WHERE id = $1", params: ["3"], tag: "SELECT 1" },
    ];
    const requests = [
      { id: 1, tab: "alice", method: "POST", url: "/api/orders", type: "fetch", start: 90, end: 160, status: 200 },
      // Held at a race barrier until 140: its window starts when it reached the app.
      { id: 2, tab: "bob", method: "POST", url: "/api/orders", type: "fetch", start: 95, sent: 140, end: 200, status: 200 },
    ];
    const traced = attribute(statements, requests, []);
    assert.deepEqual(traced[1]!.sources.map((s) => s.label), ["alice POST /api/orders"]);
    assert.deepEqual(traced[3]!.sources.map((s) => s.label), ["alice POST /api/orders", "bob POST /api/orders"]);
    assert.deepEqual(traced[4]!.sources, []);
    assert.deepEqual(writeTarget("WITH x AS (SELECT 1) UPDATE public.products SET a = 1"), { op: "UPDATE", table: "public.products" });

    const diff = { summary: "orders +1", tables: { orders: { added: [{ id: 1 }], removed: [], changed: [] } } };
    const lines = traceLines(traced, diff, ["products", "users"], {
      handlerFor: (_m, p) => (p === "/api/orders" ? "app/api/orders/route.ts" : undefined),
      // The UPDATE's SQL is in the handler; the INSERT's in a helper.
      locate: (sql) => (sql.startsWith("UPDATE") ? ["app/api/orders/route.ts:83"] : sql.startsWith("INSERT") ? ["lib/orders.ts:12"] : []),
      externals: [{ at: 145, text: "[payment provider] created charge ch_0001 (order 1)" }],
    }, { perTable: 3, tables: 5 }).join("\n");
    // The writing requests' read of the table, then the payment call between it and the write.
    assert.match(lines, /products \(no rows changed\):\n {4}140 alice\|bob POST \/api\/orders → app\/api\/orders\/route\.ts: SELECT stock FROM products WHERE id = \$1 \[3\] → SELECT 1 \(c2\)\n {4}145 \[payment provider\] created charge ch_0001 \(order 1\)\n {4}150 alice\|bob POST \/api\/orders → app\/api\/orders\/route\.ts:83: UPDATE products .* → UPDATE 0 \(c2, no tx\)/);
    assert.match(lines, /users \(no rows changed\): no statement wrote to it/);
    assert.match(lines, /orders \(\+1\):\n {4}101 alice POST \/api\/orders → app\/api\/orders\/route\.ts: INSERT INTO orders \(cart_id\) VALUES \(\$1\) \[5\] → INSERT 0 1 \(c1, tx\) \(SQL at lib\/orders\.ts:12\)/);
    // Only between statements shown for that table.
    assert.equal(lines.match(/payment provider/g)?.length, 1);
  });
});

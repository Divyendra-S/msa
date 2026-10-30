import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError } from "../src/config.ts";
import { diffSnapshots } from "../src/runner/db-diff.ts";
import { parseExperiment, tabLabels, variantsOf } from "../src/runner/experiment.ts";
import { matchesRequest, parseDuration, parseRequestPattern } from "../src/runner/match.ts";

describe("request patterns", () => {
  it("matches method and path, ignoring the query string", () => {
    const p = parseRequestPattern("POST /api/orders");
    assert.ok(matchesRequest(p, "post", "http://x/api/orders?retry=1"));
    assert.ok(matchesRequest(p, "POST", "http://x/api/orders/"));
    assert.ok(!matchesRequest(p, "GET", "http://x/api/orders"));
    assert.ok(!matchesRequest(p, "POST", "http://x/api/orders/1"));
  });

  it("supports :params, * and **", () => {
    assert.ok(matchesRequest(parseRequestPattern("GET /api/orders/:id"), "GET", "http://x/api/orders/42"));
    assert.ok(matchesRequest(parseRequestPattern("* /api/*/items"), "PUT", "http://x/api/cart/items"));
    assert.ok(matchesRequest(parseRequestPattern("* /api/**"), "DELETE", "http://x/api/a/b/c"));
    assert.ok(!matchesRequest(parseRequestPattern("GET /api/*"), "GET", "http://x/api/a/b"));
  });

  it("rejects malformed patterns", () => {
    assert.throws(() => parseRequestPattern("/api/orders"), /METHOD \/path/);
  });

  it("names a Tauri command call with invoke, * matching any part of the name", () => {
    const save = parseRequestPattern("invoke save_note");
    assert.ok(matchesRequest(save, "POST", "http://x/__windtunnel/invoke/save_note"));
    assert.ok(!matchesRequest(save, "POST", "http://x/__windtunnel/invoke/save_notes"));
    assert.ok(!matchesRequest(save, "POST", "http://x/save_note"));
    const notes = parseRequestPattern("INVOKE *_note");
    assert.ok(matchesRequest(notes, "POST", "http://x/__windtunnel/invoke/delete_note"));
    assert.ok(!matchesRequest(notes, "POST", "http://x/__windtunnel/invoke/list_notes"));
    // Plugin commands are percent-encoded in the path, as the page sends them.
    assert.ok(matchesRequest(parseRequestPattern("invoke plugin:event|emit"), "POST", "http://x/__windtunnel/invoke/plugin%3Aevent%7Cemit"));
  });
});

describe("durations", () => {
  it("parses numbers and units", () => {
    assert.equal(parseDuration(250), 250);
    assert.equal(parseDuration("250ms"), 250);
    assert.equal(parseDuration("1.5s"), 1_500);
    assert.equal(parseDuration("25h"), 90_000_000);
    assert.throws(() => parseDuration("soon"));
  });
});

describe("experiment files", () => {
  const parse = (text: string) => parseExperiment(text, "test.yaml", "test");

  it("fills in defaults", () => {
    const e = parse("flow: checkout");
    assert.equal(e.id, "test");
    assert.equal(e.repeat, 3);
    assert.equal(e.rules, "all");
    assert.deepEqual(e.perturb, []);
    assert.equal(e.timeout, 60_000);
  });

  it("parses perturbations, races and durations", () => {
    const e = parse(`flow: checkout
perturb:
  - { do: lose-response, request: POST /api/orders, step: pay }
  - { do: delay, request: "GET /api/orders/:id", ms: 3s, count: all }
  - { do: repeat, step: pay }
race: { request: POST /api/orders, order: [bob, alice], timeout: 500ms }`);
    assert.deepEqual(e.perturb[0], { do: "lose-response", request: "POST /api/orders", step: "pay", count: 1 });
    assert.deepEqual(e.perturb[1], { do: "delay", request: "GET /api/orders/:id", ms: 3_000, count: "all" });
    assert.deepEqual(e.perturb[2], { do: "repeat", step: "pay", times: 1 });
    assert.equal(e.race?.timeout, 500);
  });

  it("expands webhook shorthands", () => {
    assert.deepEqual(parse("flow: f\nwebhooks: duplicate").webhooks, { timing: "normal", times: 2, order: "sent" });
    assert.deepEqual(parse("flow: f\nwebhooks: out-of-order").webhooks, { timing: "late", times: 1, order: "reverse" });
    assert.deepEqual(parse("flow: f\nwebhooks: [early, duplicate]").webhooks, { timing: "early", times: 2, order: "sent" });
  });

  it("reports every problem with its path", () => {
    assert.throws(
      () => parse("flow: f\nperturb: [{ do: explode, step: pay }]\nrepeat: 0\ntypo: 1"),
      (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /perturb\.0\.do/);
        assert.match(err.message, /repeat/);
        assert.match(err.message, /typo/);
        return true;
      },
    );
    assert.throws(() => parse("flow: f\nperturb: [{ do: delay, request: /api, ms: 1s }]"), /METHOD \/path/);
    assert.throws(() => parseExperiment("id: other\nflow: f", "x.yaml", "x"), /must match the file name/);
  });
});

describe("variants and tabs", () => {
  it("labels extra tabs of the same user", () => {
    assert.deepEqual(
      tabLabels(["alice", "bob", "alice"]).map((t) => t.label),
      ["alice", "bob", "alice#2"],
    );
  });

  it("expands `order: each` into every ordering", () => {
    const e = parseExperiment("flow: f\nrace: { request: POST /x, order: each }", "t.yaml", "t");
    assert.deepEqual(
      variantsOf(e, ["alice", "bob"]).map((v) => v.name),
      ["together", "alice,bob", "bob,alice"],
    );
    assert.deepEqual(
      variantsOf(e, ["alice"]).map((v) => v.name),
      ["together", "1,2", "2,1"],
      "one tab: orders by arrival",
    );
    assert.deepEqual(variantsOf(parseExperiment("flow: f", "t.yaml", "t"), ["alice"]), [{ name: "default" }]);
  });
});

describe("database diff", () => {
  it("diffs rows by primary key", () => {
    const before = {
      orders: { key: ["id"], count: 1, rows: [{ id: 1, status: "pending" }] },
      products: { key: ["id"], count: 2, rows: [{ id: 1, stock: 1 }, { id: 2, stock: 5 }] },
      logs: { key: [], count: 1, rows: [{ line: "a" }] },
    };
    const after = {
      orders: { key: ["id"], count: 2, rows: [{ id: 1, status: "paid" }, { id: 2, status: "paid" }] },
      products: { key: ["id"], count: 1, rows: [{ id: 2, stock: 5 }] },
      logs: { key: [], count: 2, rows: [{ line: "a" }, { line: "a" }] },
    };
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.tables.orders, {
      added: [{ id: 2, status: "paid" }],
      removed: [],
      changed: [{ key: { id: 1 }, changes: { status: ["pending", "paid"] } }],
    });
    assert.deepEqual(diff.tables.products?.removed, [{ id: 1, stock: 1 }]);
    assert.deepEqual(diff.tables.logs?.added, [{ line: "a" }], "tables without a key compare whole rows");
    assert.equal(diff.summary, "orders +1 ~1 · products -1 · logs +1");
  });

  it("compares only counts for tables too large to read", () => {
    const diff = diffSnapshots({ big: { key: ["id"], count: 5000 } }, { big: { key: ["id"], count: 5001 } });
    assert.equal(diff.summary, "big 5000→5001 rows");
  });
});

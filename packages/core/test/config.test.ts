import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, expandVars, parseConfig } from "../src/config.ts";
import { parseRules } from "../src/rules.ts";

describe("parseConfig", () => {
  it("fills defaults", () => {
    const config = parseConfig(`
app:
  start: pnpm start --port $PORT
db:
  kind: postgres
  url: postgres://localhost/app
  seed: pnpm db:seed
`);
    assert.equal(config.app.baseUrl, "http://127.0.0.1:$PORT");
    assert.equal(config.app.ready, "/");
    assert.equal(config.parallel, 4);
    assert.deepEqual(config.users, {});
    assert.equal(config.mockPay, undefined);
  });

  it("reports every invalid field with its path", () => {
    assert.throws(
      () => parseConfig("app: {}\ndb: { kind: mysql }\nparallel: 0\n"),
      (err: Error) =>
        err instanceof ConfigError &&
        /app\.start/.test(err.message) &&
        /db\.kind/.test(err.message) &&
        /parallel/.test(err.message),
    );
  });

  it("rejects invalid YAML", () => {
    assert.throws(() => parseConfig("app: [unclosed"), ConfigError);
  });
});

describe("expandVars", () => {
  it("expands known names in both forms and keeps unknown ones", () => {
    const vars = { PORT: "4000", DATABASE_URL: "postgres://x/y" };
    assert.equal(expandVars("http://127.0.0.1:$PORT/a", vars), "http://127.0.0.1:4000/a");
    assert.equal(expandVars("${DATABASE_URL}?ssl=0", vars), "postgres://x/y?ssl=0");
    assert.equal(expandVars("$HOME_DIR and $PORTS", vars), "$HOME_DIR and $PORTS");
    assert.equal(expandVars("cost: $$5", vars), "cost: $5");
  });
});

describe("parseRules", () => {
  it("reads rules keyed by id", () => {
    const rules = parseRules("one-order-per-cart:\n  sql: SELECT 1 WHERE false\n");
    assert.deepEqual(rules, [{ id: "one-order-per-cart", sql: "SELECT 1 WHERE false", expect: "empty" }]);
  });

  it("rejects bad ids and missing sql", () => {
    assert.throws(() => parseRules("Bad Id:\n  sql: SELECT 1\n"), ConfigError);
    assert.throws(() => parseRules("ok-id:\n  description: no sql\n"), ConfigError);
  });
});

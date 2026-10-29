import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { plain, scan } from "../src/scan.ts";

const shop = join(import.meta.dirname, "..", "..", "..", "zoo", "shop");

test("scan reads a Next.js app's handlers and says what could go wrong, with no config needed", async () => {
  const result = await scan(join(shop, ".."));
  assert.equal(result.root, shop, "finds the app below the folder given");
  assert.match(result.framework, /^Next\.js /);
  const orders = result.routes.find((r) => r.method === "POST" && r.path === "/api/orders");
  assert.ok(orders, "the checkout handler");
  assert.ok(orders.risks.some((r) => r.says.startsWith("Writes `orders` after calling another service")), JSON.stringify(orders.risks));
  const webhook = result.routes.find((r) => r.path === "/api/webhooks/payment");
  assert.deepEqual(webhook?.guards, ["webhook dedupes on event id"]);
  assert.ok(!result.routes.find((r) => r.path === "/api/health")?.risks.length);
});

test("plain puts each pattern in words, and leaves an unknown one as it is", () => {
  assert.equal(
    plain("reads products, carts before tx{…} and not inside it: the transaction can act on stale rows"),
    "Reads `products`, `carts` before its transaction starts: another request can change it in between.",
  );
  assert.match(plain("external POST /v1/charges (via createCharge) without an idempotency key"), /^Calls `\/v1\/charges` with no idempotency key/);
  assert.equal(plain("something new"), "something new");
});

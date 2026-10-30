// The static app map: Next.js routes, handler effects, risky-pattern flags and page facts.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Project } from "@windtunnel/core";
import { type AppMap, buildAppMap, formatAppMap, formatEffects } from "../src/map.ts";
import { parseSql } from "../src/source.ts";

const SHOP = join(import.meta.dirname, "..", "..", "..", "zoo", "shop");

function project(root: string, users: string[] = []): Project {
  return {
    root,
    configPath: join(root, "windtunnel.config.yaml"),
    config: { users: Object.fromEntries(users.map((u) => [u, { email: `${u}@x.test`, password: "p" }])) },
    repoRoot: root,
    appSubdir: "",
    key: "test",
    stateDir: join(root, ".windtunnel"),
    cacheDir: join(root, ".cache"),
  } as unknown as Project;
}

describe("parseSql", () => {
  it("reads the operation, tables, guards and conflict handling", () => {
    assert.deepEqual(parseSql("UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1")?.guarded, true);
    assert.deepEqual(parseSql("UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING cart_id")?.guarded, false);
    assert.equal(parseSql("UPDATE orders SET status = 'paid' WHERE id = $1 RETURNING cart_id")?.text, "UPDATE orders SET status = 'paid' WHERE id = $1");
    assert.equal(parseSql("INSERT INTO orders (a) VALUES ($1) ON CONFLICT (cart_id) DO NOTHING")?.onConflict, true);
    assert.deepEqual(parseSql("SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1")?.tables, ["sessions", "users"]);
    assert.equal(parseSql("SELECT stock FROM products WHERE id = $1 FOR UPDATE")?.forUpdate, true);
    assert.equal(parseSql("Select a product to continue"), undefined);
    assert.equal(parseSql("Please update your settings"), undefined);
  });
});

describe("app map of the Bug Zoo shop", () => {
  let map: AppMap;
  let text: string;
  before(async () => {
    map = await buildAppMap(project(SHOP, ["alice", "bob"]));
    text = formatAppMap(map);
  });

  it("finds every route handler and page", () => {
    assert.match(map.framework, /^Next\.js/);
    assert.deepEqual(
      map.routes.map((r) => `${r.method} ${r.path}`).sort(),
      [
        "DELETE /api/session",
        "GET /api/cart",
        "GET /api/health",
        "GET /api/orders/:id",
        "GET /api/products",
        "POST /api/cart/items",
        "POST /api/orders",
        "POST /api/session",
        "POST /api/webhooks/payment",
        "PUT /api/products/:id",
      ],
    );
    assert.ok(map.pages.some((p) => p.path === "/orders/:id" && p.kind === "page"));
  });

  it("describes what a handler does, in order, through helpers and transactions", () => {
    const orders = map.routes.find((r) => r.method === "POST" && r.path === "/api/orders")!;
    const line = formatEffects(orders.effects);
    assert.match(line, /^auth:getCurrentUser · getUserCart→SELECT carts · getCheckoutCart→SELECT carts · tx\{ SELECT carts FOR UPDATE · getCartItems→SELECT cart_items\+products · INSERT orders ON CONFLICT \(cart_id\) DO NOTHING/);
    assert.ok(!orders.flags.some((f) => f.startsWith("reads ")), "the cart is read again inside the transaction");
    assert.match(line, /UPDATE products SET stock = stock - \$1 WHERE id = \$2 AND stock >= \$1/);
    assert.match(line, /createCharge→fetch POST \/v1\/charges \[idempotency key sent\] · UPDATE orders SET status = 'processing'/);
    assert.equal(orders.comment, "Checkout: turn the user's cart into an order and charge it.");
  });

  it("flags patterns worth an experiment, and notices the guards", () => {
    const webhook = map.routes.find((r) => r.path === "/api/webhooks/payment")!;
    assert.deepEqual(webhook.notes, ["webhook dedupes on event id"]);
    assert.ok(webhook.flags.some((f) => f.startsWith("blind UPDATE orders")));
    const orders = map.routes.find((r) => r.method === "POST" && r.path === "/api/orders")!;
    assert.ok(!orders.flags.some((f) => /idempotency key|check-then-act/.test(f)), orders.flags.join("; "));
    const products = map.routes.find((r) => r.path === "/api/products/:id")!;
    assert.ok(!products.flags.some((f) => f.startsWith("blind")), "the version check guards the update");
    assert.deepEqual(map.helperFlags, [], "the session lookup checks expiry");
  });

  it("lists page buttons, form labels and the requests their components send", () => {
    assert.match(text, /\/cart {2}app\/cart\/page\.tsx {2}login required · buttons "Paying… \/ Pay now" · shows .* · → POST \/api\/orders/);
    assert.match(text, /\/orders\/:id .*shows .*"Order confirmed", "Payment failed", "Processing payment…"/);
    assert.match(text, /\/login {2}app\/login\/page\.tsx {2}fields "Email", "Password" · buttons "Log in" · .*→ POST \/api\/session/);
    assert.match(text, /\/admin\/products\/:id .*"Someone else changed this product since you opened it\. Reload to see their changes\."/);
    assert.match(text, /\/admin\/products\/:id .*→ PUT \/api\/products\/\*/);
    assert.ok(text.length < 12_000, `map is ${text.length} chars`);
  });
});

describe("app map patterns", () => {
  let root: string;
  let map: AppMap;
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { next: "^15.1.0" } }),
    "tsconfig.json": `{ // comments are allowed
      "compilerOptions": { "paths": { "~/*": ["./src/*"] } } }`,
    "src/lib/db.ts": `export const db = {} as any; export const prisma = {} as any;
export async function sql(text: string, params: unknown[] = []) { return db.query(text, params); }`,
    "src/lib/session.ts": `import { sql } from "~/lib/db";
export async function requireUser(sid: string) {
  return sql("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [sid]);
}`,
    "src/lib/mail.ts": `export async function sendReceipt(to: string) {
  await fetch("https://mail.example/send", { method: "POST", body: to });
}`,
    // Route group and dynamic segment; check-then-act on seats; Prisma.
    "src/app/(shop)/events/[id]/book/route.ts": `import { prisma, sql } from "~/lib/db";
import { requireUser } from "~/lib/session";
import { sendReceipt } from "../../../../../lib/mail";
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser("x");
  const event = await sql("SELECT seats_left FROM events WHERE id = $1", [1]);
  await sql("UPDATE events SET seats_left = seats_left - 1 WHERE id = $1", [1]);
  await prisma.booking.create({ data: { userId: 1 } });
  await sendReceipt("a@b.c");
  return Response.json({ ok: true });
}`,
    // Pages router API with no auth.
    "src/pages/api/admin/reset.ts": `import { sql } from "~/lib/db";
export default async function handler(req: any, res: any) {
  await sql("DELETE FROM bookings WHERE event_id = $1", [req.query.id]);
  await sql("UPDATE events SET seats_left = 100 WHERE id = $1", [req.query.id]);
  res.json({ ok: true });
}`,
    // Server action.
    "src/app/actions.ts": `"use server";
import { sql } from "~/lib/db";
export async function rename(id: number, name: string) {
  await sql("UPDATE profiles SET name = $2 WHERE id = $1", [id, name]);
}`,
  };

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-map-"));
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    map = await buildAppMap(project(root));
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("says what it matches when a focus finds nothing", () => {
    assert.match(formatAppMap(map, { focus: "nope" }), /^Nothing in the map matches "nope"[\s\S]*Routes: ACTION rename/);
    assert.match(formatAppMap(map, { focus: "seats_left" }), /POST \/events\/:id\/book/, "focus matches what a handler does");
  });

  it("handles route groups, dynamic segments, the Pages Router and server actions", () => {
    assert.deepEqual(
      map.routes.map((r) => `${r.method} ${r.path}`).sort(),
      ["ACTION rename", "ANY /api/admin/reset", "POST /events/:id/book"],
    );
  });

  it("flags check-then-act, blind writes, missing auth and non-idempotent external calls", () => {
    const book = map.routes.find((r) => r.path === "/events/:id/book")!;
    assert.match(formatEffects(book.effects), /auth:requireUser · SELECT events · UPDATE events SET seats_left = seats_left - 1 WHERE id = \$1 · booking\.create\(\) · sendReceipt→fetch POST https:\/\/mail\.example\/send/);
    assert.ok(book.flags.some((f) => f.startsWith("check-then-act on events")), book.flags.join("; "));
    assert.ok(book.flags.some((f) => f.startsWith("external POST https://mail.example/send (via sendReceipt) without an idempotency key")));
    const reset = map.routes.find((r) => r.path === "/api/admin/reset")!;
    assert.ok(reset.flags.includes("no auth or signature check found"));
    assert.ok(reset.flags.some((f) => f.startsWith("2 writes outside a transaction")));
    assert.deepEqual(map.helperFlags.map((f) => f.split(":")[0]), ["src/lib/session.ts requireUser"]);
  });
});

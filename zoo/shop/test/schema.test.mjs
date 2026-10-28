// Database constraints the shop relies on. Wind Tunnel runs these against a fresh copy of the
// seed data ($DATABASE_URL); each test rolls back what it did.
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";

const url = process.env.DATABASE_URL;

async function inTransaction(fn) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("BEGIN");
    await fn(db);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
}

async function userId(db, email) {
  const { rows } = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  return rows[0].id;
}

test("a user has at most one open cart", { skip: !url && "DATABASE_URL is not set" }, () =>
  inTransaction(async (db) => {
    const alice = await userId(db, "alice@example.test");
    await db.query("INSERT INTO carts (user_id) VALUES ($1)", [alice]);
    await assert.rejects(db.query("INSERT INTO carts (user_id) VALUES ($1)", [alice]), /duplicate key/);
  }));

test("a cart becomes at most one order", { skip: !url && "DATABASE_URL is not set" }, () =>
  inTransaction(async (db) => {
    const alice = await userId(db, "alice@example.test");
    const { rows } = await db.query("INSERT INTO carts (user_id, status) VALUES ($1, 'ordered') RETURNING id", [alice]);
    const order = "INSERT INTO orders (user_id, cart_id, total_cents) VALUES ($1, $2, 100)";
    await db.query(order, [alice, rows[0].id]);
    await assert.rejects(db.query(order, [alice, rows[0].id]), /duplicate key/);
  }));

test("every product starts in stock with a price", { skip: !url && "DATABASE_URL is not set" }, () =>
  inTransaction(async (db) => {
    const { rows } = await db.query("SELECT count(*)::int AS n FROM products WHERE stock < 0 OR price_cents <= 0");
    assert.equal(rows[0].n, 0);
  }));

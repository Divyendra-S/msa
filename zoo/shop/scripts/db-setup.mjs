// Creates the schema and seed data in $DATABASE_URL (an empty database).
import { createHash, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const users = [
  { email: "alice@example.test", name: "Alice", password: "test" },
  { email: "bob@example.test", name: "Bob", password: "test" },
];

const products = [
  { slug: "ceramic-mug", name: "Ceramic Mug", description: "Holds 350 ml of coffee.", price: 1400, stock: 25 },
  { slug: "wool-socks", name: "Wool Socks", description: "Merino blend, one size.", price: 950, stock: 40 },
  { slug: "zip-hoodie", name: "Zip Hoodie", description: "Heavyweight cotton.", price: 4900, stock: 12 },
  { slug: "canvas-cap", name: "Canvas Cap", description: "Adjustable strap.", price: 1900, stock: 30 },
  { slug: "tote-bag", name: "Tote Bag", description: "Fits a laptop.", price: 1600, stock: 20 },
  { slug: "limited-print", name: "Limited Print", description: "Signed, numbered, one left.", price: 2500, stock: 1 },
];

// Salt is derived from the email so every seeded copy is byte-for-byte identical.
function hashPassword(email, password) {
  const salt = createHash("sha256").update(email).digest("hex").slice(0, 32);
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString("hex")}`;
}

const client = new pg.Client({ connectionString: url, application_name: "shop-setup" });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  for (const u of users) {
    await client.query("INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)", [
      u.email,
      u.name,
      hashPassword(u.email, u.password),
    ]);
  }
  for (const p of products) {
    await client.query(
      "INSERT INTO products (slug, name, description, price_cents, stock) VALUES ($1, $2, $3, $4, $5)",
      [p.slug, p.name, p.description, p.price, p.stock],
    );
  }
  await client.query("COMMIT");
  console.log(`seeded ${users.length} users and ${products.length} products`);
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  await client.end();
}

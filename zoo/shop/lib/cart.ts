import type { PoolClient } from "pg";
import { query, queryOne } from "./db";

export interface CartItem {
  product_id: number;
  name: string;
  quantity: number;
  price_cents: number;
}

export interface Cart {
  id: number;
  user_id: number;
  status: "open" | "ordered" | "checked_out";
}

export async function getOpenCart(userId: number): Promise<Cart | undefined> {
  return queryOne<Cart>("SELECT id, user_id, status FROM carts WHERE user_id = $1 AND status = 'open'", [userId]);
}

/**
 * The cart to check out: the open one, or else the latest one that already became an order and
 * is waiting for payment (the same checkout again: a retry, a second tab, Back).
 */
export async function getCheckoutCart(userId: number): Promise<Cart | undefined> {
  return queryOne<Cart>(
    `SELECT id, user_id, status FROM carts
      WHERE user_id = $1 AND status IN ('open', 'ordered')
      ORDER BY status = 'open' DESC, id DESC
      LIMIT 1`,
    [userId],
  );
}

/** One of the user's carts, by id (the cart a page was showing). */
export async function getUserCart(userId: number, cartId: number): Promise<Cart | undefined> {
  return queryOne<Cart>("SELECT id, user_id, status FROM carts WHERE id = $1 AND user_id = $2", [cartId, userId]);
}

/**
 * The user's open cart, created if needed and locked until the transaction ends. If a checkout
 * holds the cart, this waits for it and then uses a new cart once that one became an order.
 */
export async function lockOpenCart(db: PoolClient, userId: number): Promise<Cart> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await db.query("INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) WHERE status = 'open' DO NOTHING", [
      userId,
    ]);
    const { rows } = await db.query<Cart>(
      "SELECT id, user_id, status FROM carts WHERE user_id = $1 AND status = 'open' FOR UPDATE",
      [userId],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error("could not open a cart");
}

/** Items in a cart; pass `db` to read inside a transaction. */
export async function getCartItems(cartId: number, db?: PoolClient): Promise<CartItem[]> {
  const sql = `SELECT ci.product_id, p.name, ci.quantity, p.price_cents
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY p.id`;
  return db ? (await db.query<CartItem>(sql, [cartId])).rows : query<CartItem>(sql, [cartId]);
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

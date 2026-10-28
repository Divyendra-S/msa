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
  status: "open" | "checked_out";
}

export async function getOpenCart(userId: number): Promise<Cart | undefined> {
  return queryOne<Cart>("SELECT id, user_id, status FROM carts WHERE user_id = $1 AND status = 'open'", [userId]);
}

export async function getOrCreateOpenCart(userId: number): Promise<Cart> {
  await query(
    "INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) WHERE status = 'open' DO NOTHING",
    [userId],
  );
  const cart = await getOpenCart(userId);
  if (!cart) throw new Error("could not open a cart");
  return cart;
}

export async function getCartItems(cartId: number): Promise<CartItem[]> {
  return query<CartItem>(
    `SELECT ci.product_id, p.name, ci.quantity, p.price_cents
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY p.id`,
    [cartId],
  );
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0);
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

import { getCurrentUser } from "@/lib/auth";
import { cartTotal, getCartItems, getOpenCart } from "@/lib/cart";
import { query, transaction } from "@/lib/db";
import { createCharge } from "@/lib/payments";

interface Order {
  id: number;
  status: "pending" | "processing" | "paid" | "failed";
  total_cents: number;
}

class OutOfStockError extends Error {}

// Checkout: turn the user's open cart into an order and charge it.
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in" }, { status: 401 });

  const cart = await getOpenCart(user.id);
  if (!cart) return Response.json({ error: "Your cart is empty" }, { status: 400 });
  const items = await getCartItems(cart.id);
  if (items.length === 0) return Response.json({ error: "Your cart is empty" }, { status: 400 });

  let order: Order;
  try {
    order = await transaction(async (db) => {
      // One order per cart: a repeated or concurrent checkout gets the existing order back.
      const created = await db.query<Order>(
        `INSERT INTO orders (user_id, cart_id, total_cents) VALUES ($1, $2, $3)
         ON CONFLICT (cart_id) DO NOTHING
         RETURNING id, status, total_cents`,
        [user.id, cart.id, cartTotal(items)],
      );
      const newOrder = created.rows[0];
      if (!newOrder) {
        const existing = await db.query<Order>("SELECT id, status, total_cents FROM orders WHERE cart_id = $1", [
          cart.id,
        ]);
        return existing.rows[0]!;
      }
      for (const item of items) {
        const reserved = await db.query("UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1", [
          item.quantity,
          item.product_id,
        ]);
        if (reserved.rowCount === 0) throw new OutOfStockError(item.name);
        await db.query(
          "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, $2, $3, $4)",
          [newOrder.id, item.product_id, item.quantity, item.price_cents],
        );
      }
      return newOrder;
    });
  } catch (err) {
    if (err instanceof OutOfStockError) {
      return Response.json({ error: `${err.message} is out of stock` }, { status: 409 });
    }
    throw err;
  }

  if (order.status === "paid" || order.status === "failed") {
    return Response.json({ orderId: order.id, status: order.status });
  }

  // Keyed by order, so a retried checkout gets the first charge back instead of a second one.
  const charge = await createCharge(
    { amountCents: order.total_cents, orderId: order.id },
    { idempotencyKey: `order-${order.id}` },
  );
  // The payment webhook may already have marked the order paid; only move it forward from pending.
  await query("UPDATE orders SET status = 'processing', charge_id = $2 WHERE id = $1 AND status = 'pending'", [
    order.id,
    charge.id,
  ]);
  return Response.json({ orderId: order.id, status: "processing" });
}

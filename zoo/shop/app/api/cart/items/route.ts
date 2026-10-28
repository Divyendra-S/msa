import { getCurrentUser } from "@/lib/auth";
import { getOrCreateOpenCart } from "@/lib/cart";
import { query, queryOne } from "@/lib/db";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { productId?: number; quantity?: number };
  const quantity = body.quantity ?? 1;
  if (!Number.isInteger(body.productId) || !Number.isInteger(quantity) || quantity < 1) {
    return Response.json({ error: "Invalid product or quantity" }, { status: 400 });
  }
  const product = await queryOne<{ id: number }>("SELECT id FROM products WHERE id = $1", [body.productId]);
  if (!product) return Response.json({ error: "No such product" }, { status: 404 });

  const cart = await getOrCreateOpenCart(user.id);
  await query(
    `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
     ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
    [cart.id, product.id, quantity],
  );
  const count = await queryOne<{ count: number }>(
    "SELECT coalesce(sum(quantity), 0)::int AS count FROM cart_items WHERE cart_id = $1",
    [cart.id],
  );
  return Response.json({ cartId: cart.id, count: count?.count ?? 0 });
}

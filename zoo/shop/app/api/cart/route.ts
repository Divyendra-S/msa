import { getCurrentUser } from "@/lib/auth";
import { cartTotal, getCartItems, getOpenCart } from "@/lib/cart";

// The user's open cart, for the phone app: what the cart page shows.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in" }, { status: 401 });

  const cart = await getOpenCart(user.id);
  const items = cart ? await getCartItems(cart.id) : [];
  return Response.json({
    cartId: cart?.id ?? null,
    items: items.map((i) => ({ productId: i.product_id, name: i.name, quantity: i.quantity, priceCents: i.price_cents })),
    totalCents: cartTotal(items),
  });
}

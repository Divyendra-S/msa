import { redirect } from "next/navigation";
import { PayButton } from "@/components/PayButton";
import { getCurrentUser } from "@/lib/auth";
import { cartTotal, formatPrice, getCartItems, getOpenCart } from "@/lib/cart";

export default async function CartPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/cart");

  const cart = await getOpenCart(user.id);
  const items = cart ? await getCartItems(cart.id) : [];
  if (items.length === 0) {
    return (
      <>
        <h1>Cart</h1>
        <p>Your cart is empty.</p>
      </>
    );
  }

  return (
    <>
      <h1>Cart</h1>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.product_id}>
              <td>{item.name}</td>
              <td>{item.quantity}</td>
              <td>{formatPrice(item.price_cents * item.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="price">Total: {formatPrice(cartTotal(items))}</p>
      <PayButton />
    </>
  );
}

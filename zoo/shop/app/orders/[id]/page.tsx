import { notFound, redirect } from "next/navigation";
import { OrderStatus } from "@/components/OrderStatus";
import { getCurrentUser } from "@/lib/auth";
import { formatPrice } from "@/lib/cart";
import { query, queryOne } from "@/lib/db";

interface Order {
  id: number;
  status: "pending" | "processing" | "paid" | "failed";
  total_cents: number;
}

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/login?next=/orders/${id}`);
  if (!/^\d+$/.test(id)) notFound();

  const order = await queryOne<Order>("SELECT id, status, total_cents FROM orders WHERE id = $1 AND user_id = $2", [
    Number(id),
    user.id,
  ]);
  if (!order) notFound();
  const items = await query<{ name: string; quantity: number; unit_price_cents: number }>(
    `SELECT p.name, oi.quantity, oi.unit_price_cents
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY p.id`,
    [order.id],
  );

  return (
    <>
      <h1>Order #{order.id}</h1>
      <OrderStatus orderId={order.id} initialStatus={order.status} />
      <table>
        <tbody>
          {items.map((item) => (
            <tr key={item.name}>
              <td>{item.name}</td>
              <td>{item.quantity}</td>
              <td>{formatPrice(item.unit_price_cents * item.quantity)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="price">Total: {formatPrice(order.total_cents)}</p>
    </>
  );
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { formatPrice } from "@/lib/cart";
import { query } from "@/lib/db";

interface OrderRow {
  id: number;
  status: string;
  total_cents: number;
  created_at: Date;
}

export default async function OrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/orders");

  const orders = await query<OrderRow>(
    "SELECT id, status, total_cents, created_at FROM orders WHERE user_id = $1 ORDER BY id DESC",
    [user.id],
  );
  return (
    <>
      <h1>Your orders</h1>
      {orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/orders/${o.id}`}>Order #{o.id}</Link>
                </td>
                <td>{o.status}</td>
                <td>{formatPrice(o.total_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

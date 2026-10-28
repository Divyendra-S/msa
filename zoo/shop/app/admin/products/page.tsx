import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { formatPrice } from "@/lib/cart";
import { query } from "@/lib/db";

export default async function AdminProductsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin/products");
  if (!user.is_staff) notFound();

  const products = await query<{ id: number; name: string; price_cents: number; stock: number }>(
    "SELECT id, name, price_cents, stock FROM products ORDER BY id",
  );
  return (
    <>
      <h1>Products</h1>
      <table>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>
                <Link href={`/admin/products/${p.id}`}>{p.name}</Link>
              </td>
              <td>{formatPrice(p.price_cents)}</td>
              <td>{p.stock} in stock</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

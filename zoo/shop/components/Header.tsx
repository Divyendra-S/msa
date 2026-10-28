import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { queryOne } from "@/lib/db";
import { LogoutButton } from "./LogoutButton";

export async function Header() {
  const user = await getCurrentUser();
  const cart = user
    ? await queryOne<{ count: number }>(
        `SELECT coalesce(sum(ci.quantity), 0)::int AS count
           FROM carts c LEFT JOIN cart_items ci ON ci.cart_id = c.id
          WHERE c.user_id = $1 AND c.status = 'open'`,
        [user.id],
      )
    : undefined;

  return (
    <header>
      <Link href="/" className="brand">
        Bug Zoo Shop
      </Link>
      {user ? (
        <>
          <Link href="/orders">Orders</Link>
          {user.is_staff && <Link href="/admin/products">Admin</Link>}
          <Link href="/cart">Cart ({cart?.count ?? 0})</Link>
          <span className="muted">{user.name}</span>
          <LogoutButton />
        </>
      ) : (
        <Link href="/login">Log in</Link>
      )}
    </header>
  );
}

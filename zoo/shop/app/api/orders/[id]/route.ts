import { getCurrentUser } from "@/lib/auth";
import { queryOne } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in" }, { status: 401 });

  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const order = await queryOne(
    "SELECT id, status, total_cents, created_at, paid_at FROM orders WHERE id = $1 AND user_id = $2",
    [Number(id), user.id],
  );
  if (!order) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(order);
}

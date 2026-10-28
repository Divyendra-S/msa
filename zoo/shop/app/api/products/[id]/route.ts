import { getCurrentUser } from "@/lib/auth";
import { queryOne, transaction } from "@/lib/db";

interface ProductEdit {
  name?: unknown;
  description?: unknown;
  priceCents?: unknown;
  version?: unknown;
}

// Staff edit a product's name, description and price.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in" }, { status: 401 });
  if (!user.is_staff) return Response.json({ error: "Staff only" }, { status: 403 });

  const { id } = await params;
  if (!/^\d+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as ProductEdit;
  const { name, description, priceCents, version } = body;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !Number.isInteger(priceCents) ||
    (priceCents as number) < 1 ||
    !Number.isInteger(version)
  ) {
    return Response.json({ error: "Invalid product" }, { status: 400 });
  }

  const saved = await transaction(async (db) => {
    // Save only on top of the version the editor loaded, so nobody's edit is silently overwritten.
    const updated = await db.query<{ version: number }>(
      `UPDATE products SET name = $2, description = $3, price_cents = $4, version = version + 1
        WHERE id = $1 AND version = $5
        RETURNING version`,
      [Number(id), name.trim(), description, priceCents, version],
    );
    const row = updated.rows[0];
    if (!row) return undefined;
    await db.query("INSERT INTO product_changes (product_id, user_id, base_version, new_version) VALUES ($1, $2, $3, $4)", [
      Number(id),
      user.id,
      version,
      row.version,
    ]);
    return row;
  });
  if (!saved) {
    const current = await queryOne<{ version: number }>("SELECT version FROM products WHERE id = $1", [Number(id)]);
    if (!current) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json({ error: "Someone else changed this product", version: current.version }, { status: 409 });
  }
  return Response.json({ version: saved.version });
}

import { query } from "@/lib/db";

interface Product {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
}

// Stock changes with every order: never answered from a copy made at build time.
export const dynamic = "force-dynamic";

// The catalogue, for the phone app (the web pages read it directly).
export async function GET() {
  const products = await query<Product>("SELECT id, name, description, price_cents, stock FROM products ORDER BY id");
  return Response.json({
    products: products.map((p) => ({ id: p.id, name: p.name, description: p.description, priceCents: p.price_cents, stock: p.stock })),
  });
}

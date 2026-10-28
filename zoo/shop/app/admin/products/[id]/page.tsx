import { notFound, redirect } from "next/navigation";
import { ProductForm } from "@/components/ProductForm";
import { getCurrentUser } from "@/lib/auth";
import { queryOne } from "@/lib/db";

interface Product {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  version: number;
}

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/login?next=/admin/products/${id}`);
  if (!user.is_staff || !/^\d+$/.test(id)) notFound();

  const product = await queryOne<Product>(
    "SELECT id, name, description, price_cents, version FROM products WHERE id = $1",
    [Number(id)],
  );
  if (!product) notFound();
  return (
    <>
      <h1>Edit {product.name}</h1>
      <ProductForm product={product} />
    </>
  );
}

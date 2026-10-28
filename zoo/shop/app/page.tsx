import { AddToCartButton } from "@/components/AddToCartButton";
import { formatPrice } from "@/lib/cart";
import { query } from "@/lib/db";

interface Product {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
}

export default async function HomePage() {
  const products = await query<Product>("SELECT id, name, description, price_cents, stock FROM products ORDER BY id");
  return (
    <>
      <h1>Products</h1>
      <div className="grid">
        {products.map((p) => (
          <div className="card" key={p.id}>
            <h2>{p.name}</h2>
            <span className="muted">{p.description}</span>
            <span className="price">{formatPrice(p.price_cents)}</span>
            <span className="muted">{p.stock > 0 ? `${p.stock} in stock` : "Sold out"}</span>
            <AddToCartButton productId={p.id} soldOut={p.stock <= 0} />
          </div>
        ))}
      </div>
    </>
  );
}

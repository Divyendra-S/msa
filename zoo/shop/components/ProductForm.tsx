"use client";

import { useState } from "react";

interface Product {
  id: number;
  name: string;
  description: string;
  price_cents: number;
  version: number;
}

export function ProductForm({ product }: { product: Product }) {
  const [version, setVersion] = useState(product.version);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "conflict" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState("saving");
    const res = await fetch(`/api/products/${product.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: form.get("description"),
        priceCents: Number(form.get("price")),
        version,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { version?: number; error?: string };
    if (res.ok && body.version) {
      setVersion(body.version);
      setState("saved");
    } else if (res.status === 409) {
      setState("conflict");
    } else {
      setError(body.error ?? "Could not save");
      setState("error");
    }
  }

  return (
    <form onSubmit={save}>
      <label>
        Name
        <br />
        <input name="name" defaultValue={product.name} required />
      </label>
      <label>
        Description
        <br />
        <input name="description" defaultValue={product.description} required />
      </label>
      <label>
        Price in cents
        <br />
        <input name="price" type="number" min={1} defaultValue={product.price_cents} required />
      </label>
      <button type="submit" disabled={state === "saving"}>
        Save
      </button>
      {state === "saved" && <p className="ok">Saved</p>}
      {state === "conflict" && (
        <p role="alert" className="error">
          Someone else changed this product since you opened it. Reload to see their changes.
        </p>
      )}
      {state === "error" && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}

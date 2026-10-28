"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AddToCartButton({ productId, soldOut }: { productId: number; soldOut: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "adding" | "added" | "error">("idle");

  async function add() {
    setState("adding");
    const res = await fetch("/api/cart/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId, quantity: 1 }),
    });
    if (res.status === 401) {
      router.push("/login");
      return;
    }
    setState(res.ok ? "added" : "error");
    router.refresh();
  }

  if (soldOut) return <button disabled>Sold out</button>;
  return (
    <div className="row">
      <button onClick={add} disabled={state === "adding"}>
        Add to cart
      </button>
      {state === "added" && <span className="muted">Added</span>}
      {state === "error" && <span className="error">Could not add</span>}
    </div>
  );
}

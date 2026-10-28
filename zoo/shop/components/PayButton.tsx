"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PayButton({ cartId }: { cartId: number }) {
  const router = useRouter();
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setPaying(true);
    setError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cartId }),
      });
      if (res.status === 401) {
        // Session gone: log in again and come back to the cart (it is kept with the account).
        router.push("/login?next=/cart");
        return;
      }
      const body = (await res.json()) as { orderId?: number; error?: string };
      if (!res.ok || !body.orderId) {
        setError(body.error ?? "Payment failed");
        setPaying(false);
        return;
      }
      router.push(`/orders/${body.orderId}`);
    } catch {
      setError("Network error. Please try again.");
      setPaying(false);
    }
  }

  return (
    <div className="row">
      <button onClick={pay} disabled={paying}>
        {paying ? "Paying…" : "Pay now"}
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Status = "pending" | "processing" | "paid" | "failed";

export function OrderStatus({ orderId, initialStatus }: { orderId: number; initialStatus: Status }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>(initialStatus);

  // Poll until the payment settles; the provider's webhook can take a while.
  useEffect(() => {
    if (status === "paid" || status === "failed") return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/orders/${orderId}`, { cache: "no-store" });
      if (res.status === 401) {
        // Session gone: stop asking and send the user to log in, then back here.
        clearInterval(timer);
        router.push(`/login?next=/orders/${orderId}`);
      } else if (res.ok) {
        setStatus(((await res.json()) as { status: Status }).status);
      }
    }, 400);
    return () => clearInterval(timer);
  }, [orderId, status, router]);

  if (status === "paid") return <p className="ok">Order confirmed</p>;
  if (status === "failed") return <p className="error">Payment failed</p>;
  return <p className="muted">Processing payment…</p>;
}

"use client";

import { useEffect, useState } from "react";

type Status = "pending" | "processing" | "paid" | "failed";

export function OrderStatus({ orderId, initialStatus }: { orderId: number; initialStatus: Status }) {
  const [status, setStatus] = useState<Status>(initialStatus);

  useEffect(() => {
    if (status === "paid" || status === "failed") return;
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/orders/${orderId}`, { cache: "no-store" });
      if (res.ok) setStatus(((await res.json()) as { status: Status }).status);
    }, 400);
    return () => clearTimeout(timer);
  }, [orderId, status]);

  if (status === "paid") return <p className="ok">Order confirmed</p>;
  if (status === "failed") return <p className="error">Payment failed</p>;
  return <p className="muted">Processing payment…</p>;
}

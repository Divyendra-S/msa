import { createHmac, timingSafeEqual } from "node:crypto";

// Client for the payment provider (the mock provider in development and tests).

export interface Charge {
  id: string;
  amount: number;
  currency: string;
  status: "succeeded" | "failed";
  metadata: Record<string, string>;
}

export interface PaymentEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Charge };
}

function apiUrl(): string {
  const url = process.env.PAYMENT_API_URL;
  if (!url) throw new Error("PAYMENT_API_URL is not set");
  return url.replace(/\/$/, "");
}

export async function createCharge(
  input: { amountCents: number; orderId: number },
  options: { idempotencyKey?: string } = {},
): Promise<Charge> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const res = await fetch(`${apiUrl()}/v1/charges`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amount: input.amountCents, currency: "usd", metadata: { order_id: String(input.orderId) } }),
  });
  if (!res.ok) throw new Error(`payment provider returned ${res.status}`);
  return (await res.json()) as Charge;
}

/** Checks the `mockpay-signature: t=<unix>,v1=<hex>` header against the raw body. */
export function verifyWebhookSignature(rawBody: string, header: string | null, toleranceSec = 300): boolean {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;
  const [, ts, mac] = match;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest();
  const actual = Buffer.from(mac!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

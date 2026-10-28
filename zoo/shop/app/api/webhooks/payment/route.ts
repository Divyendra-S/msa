import { transaction } from "@/lib/db";
import { type PaymentEvent, verifyWebhookSignature } from "@/lib/payments";

// Payment provider webhook: records the payment and completes the order.
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyWebhookSignature(raw, req.headers.get("mockpay-signature"))) {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }
  const event = JSON.parse(raw) as PaymentEvent;
  if (event.type !== "charge.succeeded" && event.type !== "charge.failed") {
    return Response.json({ received: true, ignored: event.type });
  }
  const charge = event.data.object;
  const orderId = Number(charge.metadata.order_id);
  if (!Number.isInteger(orderId)) return Response.json({ error: "Charge has no order" }, { status: 400 });

  await transaction(async (db) => {
    // Providers deliver at least once; handle each event id a single time.
    const first = await db.query("INSERT INTO webhook_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [
      event.id,
      event.type,
    ]);
    if (first.rowCount === 0) return;

    if (event.type === "charge.failed") {
      await db.query("UPDATE orders SET status = 'failed' WHERE id = $1 AND status <> 'paid'", [orderId]);
      return;
    }
    await db.query("INSERT INTO payments (order_id, charge_id, amount_cents) VALUES ($1, $2, $3)", [
      orderId,
      charge.id,
      charge.amount,
    ]);
    const paid = await db.query<{ cart_id: number }>(
      "UPDATE orders SET status = 'paid', charge_id = $2, paid_at = now() WHERE id = $1 RETURNING cart_id",
      [orderId, charge.id],
    );
    if (paid.rows[0]) {
      await db.query("UPDATE carts SET status = 'checked_out' WHERE id = $1", [paid.rows[0].cart_id]);
    }
  });
  return Response.json({ received: true });
}

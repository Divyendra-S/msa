import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { MockPay } from "../src/index.ts";

interface Received {
  body: string;
  signature: string;
}

describe("mock-pay", () => {
  let pay: MockPay;
  let receiver: Server;
  let webhookUrl: string;
  const received: Received[] = [];

  before(async () => {
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ body, signature: String(req.headers["mockpay-signature"]) });
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    pay = await MockPay.start();
  });

  after(async () => {
    await pay.close();
    receiver.close();
  });

  async function charge(tenant: string, amount: number, key?: string) {
    const res = await fetch(`${pay.tenantUrl(tenant)}/v1/charges`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify({ amount, metadata: { order_id: "42" } }),
    });
    return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body: (await res.json()) as { id: string } };
  }

  it("returns the same charge for a repeated idempotency key", async () => {
    pay.tenant("idem", { webhooks: "manual", chargeLatencyMs: 0 });
    const a = await charge("idem", 1500, "order-42");
    const b = await charge("idem", 1500, "order-42");
    const c = await charge("idem", 1500);
    assert.equal(a.status, 200);
    assert.equal(a.body.id, "ch_0001");
    assert.equal(b.body.id, "ch_0001");
    assert.equal(b.replayed, "true");
    assert.equal(c.body.id, "ch_0002");
    assert.equal(pay.tenant("idem").events.length, 2);
  });

  it("delivers signed webhooks automatically", async () => {
    received.length = 0;
    const t = pay.tenant("auto", { webhookUrl, webhookSecret: "whsec_x", webhookDelayMs: 5, chargeLatencyMs: 0 });
    await charge("auto", 900);
    await t.settle();
    assert.equal(received.length, 1);
    const { body, signature } = received[0]!;
    const [, ts, mac] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(signature) ?? [];
    assert.ok(ts && mac, `bad signature header: ${signature}`);
    assert.equal(mac, createHmac("sha256", "whsec_x").update(`${ts}.${body}`).digest("hex"));
    const event = JSON.parse(body) as { id: string; type: string; data: { object: { amount: number } } };
    assert.equal(event.type, "charge.succeeded");
    assert.equal(event.data.object.amount, 900);
    assert.equal(t.events[0]!.deliveries[0]!.status, 200);
  });

  it("queues events in manual mode and can deliver one twice", async () => {
    received.length = 0;
    const t = pay.tenant("manual", { webhookUrl, webhooks: "manual", chargeLatencyMs: 0 });
    await charge("manual", 700);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(received.length, 0);
    assert.equal(t.pending().length, 1);

    const res = await fetch(`${pay.url}/_control/t/manual/events/evt_0001/deliver`, {
      method: "POST",
      body: JSON.stringify({ times: 2 }),
    });
    assert.equal(res.status, 200);
    assert.equal(received.length, 2);
    assert.equal(JSON.parse(received[0]!.body).id, JSON.parse(received[1]!.body).id);
    assert.equal(t.pending().length, 0);
  });

  it("keeps tenants isolated", async () => {
    pay.tenant("iso-a", { webhooks: "manual", chargeLatencyMs: 0 });
    pay.tenant("iso-b", { webhooks: "manual", chargeLatencyMs: 0 });
    const a = await charge("iso-a", 100, "same-key");
    const b = await charge("iso-b", 100, "same-key");
    assert.equal(a.body.id, "ch_0001");
    assert.equal(b.body.id, "ch_0001");
    assert.equal(b.replayed, "false");
    const unknown = await fetch(`${pay.url}/t/nope/v1/charges`, { method: "POST", body: "{}" });
    assert.equal(unknown.status, 404);
  });
});

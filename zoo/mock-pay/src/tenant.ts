import { createHmac } from "node:crypto";

export type WebhookMode = "auto" | "manual" | "early";
export type ChargeOutcome = "succeeded" | "failed";

export interface TenantConfig {
  /** Where events are POSTed. Without it, events are recorded but never delivered. */
  webhookUrl?: string;
  /** Shared secret for the `MockPay-Signature` header. */
  webhookSecret: string;
  /**
   * `auto` delivers each event after `webhookDelayMs`; `manual` queues it for the harness;
   * `early` delivers it before the charge API answers, so the webhook beats the app's own response.
   */
  webhooks: WebhookMode;
  webhookDelayMs: number;
  /** Deliveries per event in `auto` and `early` mode; more than 1 sends duplicates. */
  webhookTimes: number;
  /** Delay before the charge API responds, like a real provider round trip. */
  chargeLatencyMs: number;
  chargeOutcome: ChargeOutcome;
}

export const defaultTenantConfig: TenantConfig = {
  webhookSecret: "whsec_test",
  webhooks: "auto",
  webhookDelayMs: 150,
  webhookTimes: 1,
  chargeLatencyMs: 20,
  chargeOutcome: "succeeded",
};

export interface Charge {
  id: string;
  object: "charge";
  amount: number;
  currency: string;
  status: ChargeOutcome;
  metadata: Record<string, string>;
  idempotency_key: string | null;
  created: number;
}

export interface Delivery {
  at: string;
  status: number | null;
  error?: string;
  durationMs: number;
}

export interface MockEvent {
  id: string;
  type: "charge.succeeded" | "charge.failed";
  created: number;
  data: { object: Charge };
  deliveries: Delivery[];
}

export interface CreateChargeInput {
  amount: number;
  currency?: string;
  metadata?: Record<string, string>;
}

/** One create-charge request, including idempotent replays. */
export interface ChargeCall {
  /** Epoch ms. */
  at: number;
  charge: string;
  replayed: boolean;
}

export interface CreateChargeResult {
  charge: Charge;
  /** The event the new charge produced; absent on a replay. */
  event?: MockEvent;
  /** True when an earlier request with the same idempotency key already created this charge. */
  replayed: boolean;
}

/**
 * One isolated payment account. Each Wind Tunnel branch gets its own tenant,
 * so ids, charges and webhook queues never leak between runs.
 */
export class Tenant {
  readonly name: string;
  config: TenantConfig;
  readonly charges: Charge[] = [];
  readonly events: MockEvent[] = [];
  /** Every create-charge request in order, replays too. */
  readonly calls: ChargeCall[] = [];
  /** Called for every new event, before any delivery. */
  onEvent?: (event: MockEvent) => void;
  private readonly byIdempotencyKey = new Map<string, Charge>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly seq = { ch: 0, evt: 0 };

  constructor(name: string, config: Partial<TenantConfig> = {}) {
    this.name = name;
    this.config = { ...defaultTenantConfig, ...config };
  }

  configure(patch: Partial<TenantConfig>): TenantConfig {
    this.config = { ...this.config, ...patch };
    return this.config;
  }

  createCharge(input: CreateChargeInput, idempotencyKey?: string): CreateChargeResult {
    if (idempotencyKey) {
      const existing = this.byIdempotencyKey.get(idempotencyKey);
      if (existing) {
        this.calls.push({ at: Date.now(), charge: existing.id, replayed: true });
        return { charge: existing, replayed: true };
      }
    }
    const charge: Charge = {
      id: this.nextId("ch"),
      object: "charge",
      amount: input.amount,
      currency: input.currency ?? "usd",
      status: this.config.chargeOutcome,
      metadata: input.metadata ?? {},
      idempotency_key: idempotencyKey ?? null,
      created: unixNow(),
    };
    this.charges.push(charge);
    this.calls.push({ at: Date.now(), charge: charge.id, replayed: false });
    if (idempotencyKey) this.byIdempotencyKey.set(idempotencyKey, charge);

    const event: MockEvent = {
      id: this.nextId("evt"),
      type: charge.status === "succeeded" ? "charge.succeeded" : "charge.failed",
      created: charge.created,
      data: { object: charge },
      deliveries: [],
    };
    this.events.push(event);
    this.onEvent?.(event);
    if (this.config.webhooks === "auto") this.schedule(event.id, this.config.webhookDelayMs);
    return { charge, event, replayed: false };
  }

  getCharge(id: string): Charge | undefined {
    return this.charges.find((c) => c.id === id);
  }

  getEvent(id: string): MockEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Events that have never been delivered (manual mode queue). */
  pending(): MockEvent[] {
    return this.events.filter((e) => e.deliveries.length === 0);
  }

  /** Deliver an event now, `times` times in a row. Used for duplicates and custom orderings. */
  async deliver(eventId: string, times = 1): Promise<Delivery[]> {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`unknown event ${eventId} in tenant ${this.name}`);
    const results: Delivery[] = [];
    for (let i = 0; i < times; i++) results.push(await this.track(this.post(event)));
    return results;
  }

  /** Wait until every scheduled and in-flight delivery has finished. */
  async settle(): Promise<void> {
    while (this.timers.size > 0 || this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
      if (this.timers.size > 0) await new Promise((r) => setTimeout(r, 10));
    }
  }

  reset(): void {
    this.cancelTimers();
    this.onEvent = undefined;
    this.charges.length = 0;
    this.calls.length = 0;
    this.events.length = 0;
    this.byIdempotencyKey.clear();
    this.seq.ch = 0;
    this.seq.evt = 0;
  }

  close(): void {
    this.cancelTimers();
  }

  snapshot() {
    return { name: this.name, config: this.config, charges: this.charges, events: this.events };
  }

  sign(body: string, timestamp = unixNow()): string {
    const mac = createHmac("sha256", this.config.webhookSecret).update(`${timestamp}.${body}`).digest("hex");
    return `t=${timestamp},v1=${mac}`;
  }

  private schedule(eventId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.getEvent(eventId)) void this.track(this.deliver(eventId, this.config.webhookTimes));
    }, delayMs);
    this.timers.add(timer);
  }

  private async post(event: MockEvent): Promise<Delivery> {
    const started = Date.now();
    const at = new Date(started).toISOString();
    if (!this.config.webhookUrl) {
      const delivery: Delivery = { at, status: null, error: "no webhookUrl configured", durationMs: 0 };
      event.deliveries.push(delivery);
      return delivery;
    }
    const { deliveries: _omit, ...payload } = event;
    const body = JSON.stringify(payload);
    let delivery: Delivery;
    try {
      const res = await fetch(this.config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "mockpay-signature": this.sign(body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      await res.arrayBuffer();
      delivery = { at, status: res.status, durationMs: Date.now() - started };
    } catch (err) {
      delivery = { at, status: null, error: (err as Error).message, durationMs: Date.now() - started };
    }
    event.deliveries.push(delivery);
    return delivery;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  private cancelTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Ids are sequential per tenant so runs of the same experiment line up. */
  private nextId(kind: "ch" | "evt"): string {
    this.seq[kind] += 1;
    return `${kind}_${String(this.seq[kind]).padStart(4, "0")}`;
  }
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

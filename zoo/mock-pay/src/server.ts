import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Tenant, type TenantConfig } from "./tenant.ts";

export interface MockPayOptions {
  port?: number;
  host?: string;
  /** Config for the `default` tenant, served at the root (`/v1/...`). */
  defaultTenant?: Partial<TenantConfig>;
}

/**
 * Mock payment provider.
 *
 * Public API (what the app under test calls), per tenant:
 *   POST /v1/charges            create a charge; honours the Idempotency-Key header
 *   GET  /v1/charges/:id
 * Tenants other than `default` live under /t/:tenant/v1/...
 *
 * Control API (what the harness calls):
 *   GET    /_control/t/:tenant                       charges, events, deliveries
 *   POST   /_control/t/:tenant/config                patch the tenant config
 *   POST   /_control/t/:tenant/events/:id/deliver    body {times?}
 *   POST   /_control/t/:tenant/reset
 *   DELETE /_control/t/:tenant
 */
export class MockPay {
  readonly url: string;
  private readonly server: Server;
  private readonly tenants = new Map<string, Tenant>();

  private constructor(server: Server, url: string, defaultTenant: Partial<TenantConfig>) {
    this.server = server;
    this.url = url;
    this.tenants.set("default", new Tenant("default", defaultTenant));
  }

  static async start(options: MockPayOptions = {}): Promise<MockPay> {
    const host = options.host ?? "127.0.0.1";
    let instance: MockPay | undefined;
    const server = createServer((req, res) => {
      if (!instance) return send(res, 503, { error: "starting" });
      instance.handle(req, res).catch((err: Error) => send(res, 500, { error: err.message }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, host, resolve);
    });
    const { port } = server.address() as AddressInfo;
    instance = new MockPay(server, `http://${host}:${port}`, options.defaultTenant ?? {});
    return instance;
  }

  /** Get or create a tenant. Passing config on an existing tenant patches it. */
  tenant(name: string, config?: Partial<TenantConfig>): Tenant {
    let t = this.tenants.get(name);
    if (!t) {
      t = new Tenant(name, config);
      this.tenants.set(name, t);
    } else if (config) {
      t.configure(config);
    }
    return t;
  }

  /** Base URL the app should use as its payment API URL for this tenant. */
  tenantUrl(name: string): string {
    return name === "default" ? this.url : `${this.url}/t/${encodeURIComponent(name)}`;
  }

  removeTenant(name: string): void {
    this.tenants.get(name)?.close();
    if (name !== "default") this.tenants.delete(name);
  }

  async close(): Promise<void> {
    for (const t of this.tenants.values()) t.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";

    if (parts[0] === "_control") return this.handleControl(method, parts.slice(1), req, res);

    let tenantName = "default";
    let rest = parts;
    if (parts[0] === "t" && parts[1]) {
      tenantName = parts[1];
      rest = parts.slice(2);
    }
    const tenant = this.tenants.get(tenantName);
    if (!tenant) return send(res, 404, { error: { message: `no such tenant: ${tenantName}` } });

    if (method === "POST" && rest.join("/") === "v1/charges") {
      const body = await readJson(req);
      const amount = body.amount;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
        return send(res, 400, { error: { message: "amount must be a positive integer (cents)" } });
      }
      const key = header(req, "idempotency-key");
      const result = tenant.createCharge(
        {
          amount,
          currency: typeof body.currency === "string" ? body.currency : undefined,
          metadata: isStringRecord(body.metadata) ? body.metadata : undefined,
        },
        key,
      );
      if (result.event && tenant.config.webhooks === "early") {
        await tenant.deliver(result.event.id, tenant.config.webhookTimes);
      }
      if (tenant.config.chargeLatencyMs > 0) await sleep(tenant.config.chargeLatencyMs);
      res.setHeader("idempotent-replayed", String(result.replayed));
      return send(res, 200, result.charge);
    }

    if (method === "GET" && rest[0] === "v1" && rest[1] === "charges" && rest[2]) {
      const charge = tenant.getCharge(rest[2]);
      return charge ? send(res, 200, charge) : send(res, 404, { error: { message: "no such charge" } });
    }

    return send(res, 404, { error: { message: `no route ${method} ${url.pathname}` } });
  }

  private async handleControl(method: string, parts: string[], req: IncomingMessage, res: ServerResponse) {
    if (parts[0] !== "t" || !parts[1]) return send(res, 404, { error: "expected /_control/t/:tenant" });
    const name = parts[1];
    const action = parts.slice(2);

    if (method === "DELETE" && action.length === 0) {
      this.removeTenant(name);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && action[0] === "config") {
      const patch = (await readJson(req)) as Partial<TenantConfig>;
      return send(res, 200, this.tenant(name, patch).config);
    }

    const tenant = this.tenants.get(name);
    if (!tenant) return send(res, 404, { error: `no such tenant: ${name}` });

    if (method === "GET" && action.length === 0) return send(res, 200, tenant.snapshot());
    if (method === "POST" && action[0] === "reset") {
      tenant.reset();
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && action[0] === "events" && action[1] && action[2] === "deliver") {
      const body = await readJson(req);
      const times = typeof body.times === "number" ? body.times : 1;
      try {
        return send(res, 200, { deliveries: await tenant.deliver(action[1], times) });
      } catch (err) {
        return send(res, 404, { error: (err as Error).message });
      }
    }
    return send(res, 404, { error: `no control route ${method} /${parts.join("/")}` });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && Object.values(v).every((x) => typeof x === "string");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

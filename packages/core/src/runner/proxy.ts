import http from "node:http";
import net from "node:net";
import {
  type Answer,
  type Call,
  callName,
  type Group,
  isHarnessCall,
  isPrefetch,
  type Network,
  type NetworkTab,
  type RequestRecord,
} from "./network.ts";

/** Header a client sets to say which tab a call comes from; the app never sees it. */
export const TAB_HEADER = "x-windtunnel-tab";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
  TAB_HEADER,
]);
const DROPPED = "canceled by the client (it closed the connection)";
const RESET = "connection reset by the harness";
const UPSTREAM_TIMEOUT_MS = 60_000;

interface Attached {
  network: Network;
  /** The tab a call names in `x-windtunnel-tab`, or the one its port belongs to. */
  tabOf: (label: string) => NetworkTab | undefined;
  /** Where calls from unknown tabs count as in flight. */
  group: Group;
}

interface ProxyAnswer extends Answer {
  headers: string[];
  body: Buffer;
}

/**
 * A reverse proxy in front of one run's app: the seam for clients the harness can't route
 * itself (a phone, a desktop app), and for a browser when asked. Until a run attaches its
 * network layer, calls pass straight through.
 *
 * Answers close the connection, so a call the harness drops is never on a reused connection
 * that the client would quietly retry.
 */
export class HttpProxy {
  readonly url: string;
  private readonly target: URL;
  private readonly server: http.Server;
  private readonly agent = new http.Agent({ keepAlive: true });
  private readonly sockets = new Set<net.Socket>();
  private attached?: Attached;

  private constructor(server: http.Server, url: string, target: URL) {
    this.server = server;
    this.url = url;
    this.target = target;
    server.on("request", (req, res) => void this.onRequest(req, res).catch(() => res.destroy()));
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as net.Socket, head));
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: { port: number; target: string; host?: string }): Promise<HttpProxy> {
    const host = options.host ?? "127.0.0.1";
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, host, () => resolve());
    });
    return new HttpProxy(server, `http://${host}:${options.port}`, new URL(options.target));
  }

  /** From now on calls go through `network`: logged, perturbed, held for races. */
  attach(attached: Attached): void {
    this.attached = attached;
  }

  detach(): void {
    this.attached = undefined;
  }

  async close(): Promise<void> {
    this.detach();
    for (const socket of this.sockets) socket.destroy();
    this.agent.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    const headers = flatHeaders(req.headers);
    const label = headers[TAB_HEADER];
    const attached = this.attached;
    const call = new ProxyCall(this, req, res, body, headers);
    if (!attached) return call.pass();

    const { network } = attached;
    const url = new URL(req.url ?? "/", this.url);
    if (isHarnessCall(url)) return call.pass();
    const type = resourceType(headers);
    const tracked = (type === "document" || type === "fetch") && !isPrefetch(headers);
    if (!tracked && !network.wants(url)) return call.pass();

    const tab = label ? attached.tabOf(label) : undefined;
    const record = network.record({
      tab: tab?.label ?? label ?? "?",
      step: tab?.stepName,
      ...callName(call.method, url),
      type,
    });
    call.track(network, record, tracked);
    if (tracked) network.opened(record, tab?.group ?? attached.group);
    if (!tab) return call.pass();
    await network.handle(call, tab, record);
  }

  /** WebSockets and other upgrades go straight to the app. */
  private onUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const upstream = net.connect(Number(this.target.port || 80), this.target.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i]!.toLowerCase() !== TAB_HEADER) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }

  /** Sends a request to the app; `onResponse` gets its head, and its body as a stream. */
  upstream(
    req: http.IncomingMessage,
    headers: Record<string, string>,
    body: Buffer,
    onResponse: (res: http.IncomingMessage) => void,
    onError: (err: Error) => void,
  ): http.ClientRequest {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
    if (body.length > 0) out["content-length"] = String(body.length);
    const request = http.request(
      {
        host: this.target.hostname,
        port: this.target.port || 80,
        method: req.method,
        path: req.url,
        // The Host header stays the proxy's, so the app builds links (and checks origins) for it.
        headers: out,
        agent: this.agent,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      onResponse,
    );
    request.on("error", onError);
    request.on("timeout", () => request.destroy(new Error(`the app did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s`)));
    request.end(body);
    return request;
  }

  /** The app's headers as the client should get them: hop-by-hop ones dropped, its own address rewritten to the proxy's. */
  clientHeaders(raw: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i]!;
      let value = raw[i + 1]!;
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      if (name.toLowerCase() === "location" && value.startsWith(this.target.origin)) value = this.url + value.slice(this.target.origin.length);
      out.push(name, value);
    }
    out.push("connection", "close");
    return out;
  }
}

/** One proxied request as a call the network layer can hold, perturb or let through. */
class ProxyCall implements Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: Buffer;
  tracked = false;
  private readonly proxy: HttpProxy;
  private readonly req: http.IncomingMessage;
  private readonly res: http.ServerResponse;
  private readonly raw: Buffer;
  private network?: Network;
  private record?: RequestRecord;
  private dropped = false;
  /** The client went away while the call was held: settled once the harness lets go of it. */
  private gone = false;

  constructor(proxy: HttpProxy, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer, headers: Record<string, string>) {
    this.proxy = proxy;
    this.req = req;
    this.res = res;
    this.raw = body;
    this.method = req.method ?? "GET";
    this.url = new URL(req.url ?? "/", proxy.url).href;
    this.headers = headers;
    this.body = body.length > 0 ? body : undefined;
  }

  /** Logs the call's answer and end in `record`. */
  track(network: Network, record: RequestRecord, tracked: boolean): void {
    this.network = network;
    this.record = record;
    this.tracked = tracked;
    this.res.once("finish", () => network.settle(record));
    this.res.once("close", () => {
      if (this.res.writableFinished) return;
      if (network.isHeld(record)) this.gone = true;
      else network.settle(record, this.dropped ? RESET : DROPPED);
    });
  }

  send(): Promise<ProxyAnswer> {
    return new Promise((resolve, reject) => {
      this.proxy.upstream(
        this.req,
        this.headers,
        this.raw,
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.rawHeaders, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
        reject,
      );
    });
  }

  async answer(answer: Answer): Promise<void> {
    const a = answer as ProxyAnswer;
    this.respond(a.status, this.proxy.clientHeaders(a.headers), a.body);
  }

  async fulfill(status: number, body: string): Promise<void> {
    this.respond(status, ["content-type", "text/plain", "content-length", String(Buffer.byteLength(body)), "connection", "close"], Buffer.from(body));
  }

  async drop(): Promise<void> {
    this.dropped = true;
    if (this.record) this.network?.settle(this.record, RESET);
    this.req.socket.destroy();
  }

  pass(): Promise<void> {
    return new Promise((resolve) => {
      const upstream = this.proxy.upstream(
        this.req,
        this.headers,
        this.raw,
        (res) => {
          if (this.closed()) {
            res.resume();
            return resolve();
          }
          this.head(res.statusCode ?? 502, this.proxy.clientHeaders(res.rawHeaders));
          res.pipe(this.res);
          res.on("end", () => resolve());
          res.on("error", () => {
            this.res.destroy();
            resolve();
          });
        },
        (err) => {
          // The app is down or gave up: the client sees a network error, as it would without the proxy.
          if (this.record) this.network?.settle(this.record, `the app did not answer: ${err.message}`);
          this.res.destroy();
          resolve();
        },
      );
      // A client that stops waiting stops the app's request too, like a direct connection.
      this.res.once("close", () => {
        if (!this.res.writableFinished) upstream.destroy();
      });
    });
  }

  private respond(status: number, headers: string[], body: Buffer): void {
    if (this.closed()) {
      if (this.gone && this.record) this.network?.settle(this.record, DROPPED);
      return;
    }
    this.head(status, headers);
    this.res.end(body);
  }

  private head(status: number, headers: string[]): void {
    if (this.record) {
      this.record.response ??= this.network!.now();
      this.record.status = status;
    }
    this.res.writeHead(status, headers);
  }

  private closed(): boolean {
    return this.res.destroyed || this.res.writableEnded;
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function flatHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/**
 * What the client asked for, from `sec-fetch-dest`: a page, an API call, or a script, image… An
 * event stream stays open, so it isn't an API call steps wait for. Clients that don't say make API calls.
 */
function resourceType(headers: Record<string, string>): string {
  if (headers.accept?.includes("text/event-stream")) return "eventsource";
  const dest = headers["sec-fetch-dest"];
  if (dest === "document" || dest === "iframe" || dest === "frame") return "document";
  if (!dest || dest === "empty") return "fetch";
  return dest;
}

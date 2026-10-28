import { createServer, type Server, type Socket, connect } from "node:net";

/** One statement the app ran, as seen on the wire. */
export interface SqlRecord {
  /** When it was sent (epoch ms; the runner rewrites it to ms since the run started). */
  at: number;
  /** Until the server finished it. */
  ms: number;
  /** Connection number within the database (1, 2, …). */
  conn: number;
  sql: string;
  /** Bound parameters as text (cut to 60 characters); binary ones as `<binary n bytes>`. */
  params?: (string | null)[];
  /** Command tag, e.g. `INSERT 0 1`, `UPDATE 0`, `SELECT 3`. */
  tag?: string;
  /** `23505 duplicate key value violates unique constraint "…"` */
  error?: string;
  /** Ran inside a transaction block. */
  tx?: boolean;
}

/** Statements of one database, filled while its connections run. */
export interface SqlLog {
  readonly records: SqlRecord[];
  /** Statements not kept once `MAX_RECORDS` was reached. */
  dropped: number;
  stop(): void;
}

const MAX_RECORDS = 20_000;
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const PROTOCOL_3 = 196608;

/**
 * A Postgres wire-protocol proxy that logs the statements of the databases it is told to
 * record, with their parameters, results and timing. Apps connect to it instead of the
 * server; nothing in the app changes. Connections to other databases pass through unlogged.
 * TLS is declined, so it is for local servers.
 */
export class SqlProxy {
  readonly port: number;
  private readonly server: Server;
  private readonly logs = new Map<string, SqlLog & { connections: number }>();
  private readonly sockets = new Set<Socket>();

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static async start(upstream: { host: string; port: number }): Promise<SqlProxy> {
    let proxy: SqlProxy | undefined;
    const server = createServer((client) => proxy?.handle(client, upstream));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    proxy = new SqlProxy(server, typeof address === "object" && address ? address.port : 0);
    return proxy;
  }

  /** `url` with its host and port pointing at this proxy. */
  urlFor(url: string): string {
    const u = new URL(url);
    u.hostname = "127.0.0.1";
    u.port = String(this.port);
    return u.href;
  }

  /** Starts logging connections to `database` (connections opened from now on). */
  record(database: string): SqlLog {
    const log: SqlLog & { connections: number } = {
      records: [],
      dropped: 0,
      connections: 0,
      stop: () => {
        if (this.logs.get(database) === log) this.logs.delete(database);
      },
    };
    this.logs.set(database, log);
    return log;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(client: Socket, upstream: { host: string; port: number }): void {
    this.sockets.add(client);
    client.on("close", () => this.sockets.delete(client));
    client.on("error", () => undefined);
    let pending = Buffer.alloc(0);

    // Before the startup message the client may ask for TLS or GSS encryption: decline both.
    const onStartup = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readInt32BE(0);
        if (length < 8 || length > 10_000) return client.destroy();
        if (pending.length < length) return;
        const code = pending.readInt32BE(4);
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          client.write("N");
          continue;
        }
        client.off("data", onStartup);
        const params = code === PROTOCOL_3 ? startupParams(message.subarray(8)) : {};
        const database = params.database ?? params.user ?? "";
        const log = code === PROTOCOL_3 ? this.logs.get(database) : undefined;
        this.connectUpstream(client, upstream, Buffer.concat([message, pending]), log);
        return;
      }
    };
    client.on("data", onStartup);
  }

  private connectUpstream(
    client: Socket,
    upstream: { host: string; port: number },
    first: Buffer,
    log: (SqlLog & { connections: number }) | undefined,
  ): void {
    client.pause();
    const server = connect(upstream.port, upstream.host);
    this.sockets.add(server);
    server.on("close", () => {
      this.sockets.delete(server);
      client.destroy();
    });
    client.on("close", () => server.destroy());
    server.on("error", () => client.destroy());
    server.once("connect", () => {
      // The startup message itself is untyped: parsing starts with what follows it.
      const startupLength = first.readInt32BE(0);
      server.write(first);
      if (log) {
        const conn = new ConnectionLog(log, ++log.connections);
        const fromClient = new MessageReader((type, body) => conn.frontend(type, body), FRONTEND_TYPES);
        const fromServer = new MessageReader((type, body) => conn.backend(type, body), BACKEND_TYPES);
        fromClient.push(first.subarray(startupLength));
        client.on("data", (chunk: Buffer) => fromClient.push(chunk));
        server.on("data", (chunk: Buffer) => fromServer.push(chunk));
      }
      client.pipe(server);
      server.pipe(client);
      client.resume();
    });
  }
}

/** Message types whose bodies are parsed; others are only skipped over. */
const FRONTEND_TYPES = new Set(["Q", "P", "B", "E", "S"]);
const BACKEND_TYPES = new Set(["C", "E", "I", "s", "Z"]);

/** Splits a stream of typed messages (type byte + int32 length + body), keeping bodies only for `keep` types. */
class MessageReader {
  private head = Buffer.alloc(0);
  private current?: { type: string; left: number; keep: boolean; parts: Buffer[] };
  private broken = false;
  private readonly onMessage: (type: string, body: Buffer) => void;
  private readonly keep: Set<string>;

  constructor(onMessage: (type: string, body: Buffer) => void, keep: Set<string>) {
    this.onMessage = onMessage;
    this.keep = keep;
  }

  push(chunk: Buffer): void {
    let offset = 0;
    while (!this.broken && offset < chunk.length) {
      if (!this.current) {
        const take = Math.min(5 - this.head.length, chunk.length - offset);
        this.head = Buffer.concat([this.head, chunk.subarray(offset, offset + take)]);
        offset += take;
        if (this.head.length < 5) return;
        const type = String.fromCharCode(this.head[0]!);
        const left = this.head.readInt32BE(1) - 4;
        this.head = Buffer.alloc(0);
        if (left < 0) {
          this.broken = true; // out of sync: stop logging, keep proxying
          return;
        }
        this.current = { type, left, keep: this.keep.has(type), parts: [] };
      }
      const take = Math.min(this.current.left, chunk.length - offset);
      if (this.current.keep) this.current.parts.push(chunk.subarray(offset, offset + take));
      this.current.left -= take;
      offset += take;
      if (this.current.left === 0) {
        const { type, keep, parts } = this.current;
        this.current = undefined;
        try {
          this.onMessage(type, keep ? Buffer.concat(parts) : EMPTY);
        } catch {
          this.broken = true;
        }
      }
    }
  }
}

const EMPTY = Buffer.alloc(0);

interface Queued {
  /** `exec`: an Execute or simple Query waiting for its result; `sync`: a Sync. */
  kind: "exec" | "sync";
  simple?: boolean;
  record?: SqlRecord;
  done?: boolean;
}

/** Pairs a connection's statements with their results. */
class ConnectionLog {
  private readonly statements = new Map<string, string>();
  private readonly portals = new Map<string, { sql: string; params: (string | null)[] }>();
  private readonly queue: Queued[] = [];
  private inTx = false;
  private readonly log: SqlLog;
  private readonly conn: number;

  constructor(log: SqlLog, conn: number) {
    this.log = log;
    this.conn = conn;
  }

  frontend(type: string, body: Buffer): void {
    const r = new BodyReader(body);
    if (type === "Q") {
      this.queue.push({ kind: "exec", simple: true, record: this.start(r.cstring(), undefined) });
    } else if (type === "P") {
      const name = r.cstring();
      this.statements.set(name, r.cstring());
    } else if (type === "B") {
      const portal = r.cstring();
      const statement = r.cstring();
      const formats = Array.from({ length: r.int16() }, () => r.int16());
      const params = Array.from({ length: r.int16() }, (_, i) => {
        const length = r.int32();
        if (length < 0) return null;
        const bytes = r.bytes(length);
        const binary = (formats.length === 1 ? formats[0] : formats[i]) === 1;
        return binary ? `<binary ${length} bytes>` : clip(bytes.toString("utf8"));
      });
      this.portals.set(portal, { sql: this.statements.get(statement) ?? "(unknown statement)", params });
    } else if (type === "E") {
      const portal = this.portals.get(r.cstring());
      this.queue.push({ kind: "exec", record: this.start(portal?.sql ?? "(unknown portal)", portal?.params) });
    } else if (type === "S") {
      this.queue.push({ kind: "sync" });
    }
  }

  backend(type: string, body: Buffer): void {
    const r = new BodyReader(body);
    if (type === "Z") {
      this.inTx = String.fromCharCode(body[0] ?? 73) !== "I";
      // Everything up to the Sync (or simple query) this answers is over; unanswered executes were skipped after an error.
      while (this.queue.length) {
        const item = this.queue.shift()!;
        if (item.kind === "exec" && item.simple && !item.done) this.finish(item, {});
        if (item.kind === "sync" || item.simple) break;
      }
      return;
    }
    const head = this.queue.find((q) => q.kind === "exec" && !q.done);
    if (!head) return;
    if (type === "C") {
      const tag = r.cstring();
      if (head.simple) head.record!.tag = head.record!.tag ? `${head.record!.tag}; ${tag}` : tag;
      else this.finish(head, { tag });
    } else if (type === "I") {
      if (!head.simple) this.finish(head, { tag: "" });
    } else if (type === "s") {
      this.finish(head, { tag: "(suspended)" });
    } else if (type === "E") {
      const fields = errorFields(body);
      this.finish(head, { error: [fields.C, fields.M].filter(Boolean).join(" ") });
    }
  }

  private start(sql: string, params: (string | null)[] | undefined): SqlRecord {
    return { at: Date.now(), ms: 0, conn: this.conn, sql, ...(params?.length ? { params } : {}), ...(this.inTx ? { tx: true } : {}) };
  }

  private finish(item: Queued, result: { tag?: string; error?: string }): void {
    item.done = true;
    const record = item.record!;
    record.ms = Date.now() - record.at;
    if (result.tag !== undefined && !record.tag) record.tag = result.tag;
    if (result.error) record.error = result.error;
    if (this.log.records.length < MAX_RECORDS) this.log.records.push(record);
    else this.log.dropped++;
  }
}

class BodyReader {
  private offset = 0;
  private readonly body: Buffer;

  constructor(body: Buffer) {
    this.body = body;
  }

  cstring(): string {
    const end = this.body.indexOf(0, this.offset);
    const stop = end === -1 ? this.body.length : end;
    const text = this.body.toString("utf8", this.offset, stop);
    this.offset = stop + 1;
    return text;
  }

  int16(): number {
    const v = this.body.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  int32(): number {
    const v = this.body.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  bytes(n: number): Buffer {
    const b = this.body.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
}

function startupParams(body: Buffer): Record<string, string> {
  const parts = body.toString("utf8").split("\0");
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < parts.length && parts[i]; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

function errorFields(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset]!);
    const end = body.indexOf(0, offset + 1);
    if (end === -1) break;
    out[code] = body.toString("utf8", offset + 1, end);
    offset = end + 1;
  }
  return out;
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

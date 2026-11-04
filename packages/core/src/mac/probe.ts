import { createServer, type IncomingMessage, type Server } from "node:http";
import { POINT_PATH } from "../runner/match.ts";
import type { Answer, Call } from "../runner/network.ts";

/** What the harness tells the code at a point (swift/WindTunnelProbe): go on, throw, or be cancelled and go on. */
type Decision = { do: "go" | "cancel"; id?: number } | { do: "throw" };

/**
 * A probe point the app's code reached, as a call at the seam. While it is undecided the code
 * waits there. Sending it lets the code go on and resolves once the section it covers has
 * finished (at once for a bare point), so a race released one at a time runs each section
 * whole before the next.
 */
export class PointCall implements Call {
  readonly method = "POINT";
  readonly url: string;
  readonly headers: Record<string, string> = {};
  readonly tracked = true;
  readonly name: string;
  private readonly decide: (decision: Decision) => void;
  /** The section's end, once the code was let go; undefined for a bare point. */
  private readonly section?: { id: number; done: Promise<void> };
  private decided = false;
  private went?: Promise<Answer>;

  constructor(name: string, decide: (decision: Decision) => void, section?: { id: number; done: Promise<void> }) {
    this.name = name;
    this.url = `http://probe${POINT_PATH}${encodeURIComponent(name)}`;
    this.decide = decide;
    this.section = section;
  }

  send(): Promise<Answer> {
    this.went ??= this.go("go");
    return this.went;
  }

  /** The code already went on when it was sent. */
  async answer(): Promise<void> {}

  /** The code throws ProbeError at the point. */
  async fulfill(): Promise<void> {
    this.reply({ do: "throw" });
  }

  async drop(): Promise<void> {
    this.reply({ do: "throw" });
  }

  async pass(): Promise<void> {
    this.reply({ do: "go", ...(this.section ? { id: this.section.id } : {}) });
  }

  /** The task is cancelled at the point and goes on; resolves when its section has finished. */
  async cancel(): Promise<void> {
    await this.go("cancel");
  }

  private async go(how: "go" | "cancel"): Promise<Answer> {
    this.reply({ do: how, ...(this.section ? { id: this.section.id } : {}) });
    await this.section?.done;
    return { status: 200 };
  }

  private reply(decision: Decision): void {
    if (this.decided) return;
    this.decided = true;
    this.decide(decision);
  }
}

export interface ProbeHandlers {
  /** A point was reached: hand it to the seam. */
  point(call: PointCall): void;
  /** A scenario step started or ended; at its end, maybe with what it showed (a JPEG). */
  step(name: string, phase: "start" | "end", error?: string, picture?: Buffer): void;
}

/**
 * Where swift/WindTunnelProbe reports to during a run, on this Mac: `POST /point {name,
 * section}` waits for the decision, `POST /done {id}` ends a section, `POST /step {name,
 * phase, picture?}` marks a scenario step (`picture`: what it showed at its end, a base64 JPEG).
 */
export class ProbeServer {
  readonly url: string;
  private readonly server: Server;
  private readonly sections = new Map<number, () => void>();
  private nextId = 1;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.url = `http://127.0.0.1:${port}/`;
  }

  static async start(port: number, handlers: ProbeHandlers): Promise<ProbeServer> {
    const server = createServer();
    const probe = new ProbeServer(server, port);
    server.on("request", (req, res) => {
      // A point decided after its process died (a crash during a race) has no one to answer.
      res.on("error", () => undefined);
      const reply = (status: number, body: object) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      void readJson(req).then(
        (body) => {
          if (req.method !== "POST") return reply(405, { error: "POST only" });
          switch (req.url) {
            case "/point": {
              if (typeof body.name !== "string" || !body.name) return reply(400, { error: "point needs a name" });
              let section: { id: number; done: Promise<void> } | undefined;
              if (body.section === true) {
                const id = probe.nextId++;
                section = { id, done: new Promise<void>((resolve) => probe.sections.set(id, resolve)) };
              }
              // A point is held by keeping its request open until the seam decides.
              return handlers.point(new PointCall(body.name, (decision) => reply(200, decision), section));
            }
            case "/done": {
              const id = Number(body.id);
              probe.sections.get(id)?.();
              probe.sections.delete(id);
              return reply(200, { do: "go" });
            }
            case "/step": {
              if (typeof body.name !== "string" || (body.phase !== "start" && body.phase !== "end")) return reply(400, { error: "step needs a name and a phase" });
              const picture = typeof body.picture === "string" ? Buffer.from(body.picture, "base64") : undefined;
              handlers.step(body.name, body.phase, typeof body.error === "string" ? body.error : undefined, picture);
              return reply(200, { do: "go" });
            }
            default:
              return reply(404, { error: `no ${req.url}` });
          }
        },
        () => reply(400, { error: "the body must be JSON" }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    return probe;
  }

  /** Ends every unfinished section (the code is gone), and stops listening. */
  async close(): Promise<void> {
    for (const done of this.sections.values()) done();
    this.sections.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const value: unknown = text ? JSON.parse(text) : {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
}

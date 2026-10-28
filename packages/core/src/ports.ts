import { createServer } from "node:net";

const handedOut = new Set<number>();

/**
 * Below the OS ephemeral ranges (macOS and Windows 49152+, Linux 32768+). A port
 * from listen(0) is an ephemeral one, which an outgoing connection (browser,
 * database client) can take as its local port before the app binds it.
 */
const RANGE = { min: 20_000, max: 30_000 };

/**
 * Finds a free TCP port. Ports handed out by this process are not reused until
 * released, so parallel branches never race for the same one.
 */
export async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const port = RANGE.min + Math.floor(Math.random() * (RANGE.max - RANGE.min));
    if (handedOut.has(port)) continue;
    if (await isPortFree(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error(`could not find a free port between ${RANGE.min} and ${RANGE.max}`);
}

export function releasePort(port: number): void {
  handedOut.delete(port);
}

/**
 * True when the port can be bound on loopback and on the wildcard address (IPv6
 * and IPv4, or IPv4 alone). Both are needed: with SO_REUSEADDR a wildcard bind
 * succeeds next to a socket on one address, and apps bind either.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if ((await tryListen(port, "127.0.0.1")) !== "free") return false;
  const wildcard = await tryListen(port, "::");
  return wildcard === "no-ipv6" ? (await tryListen(port, "0.0.0.0")) === "free" : wildcard === "free";
}

function tryListen(port: number, host: string): Promise<"free" | "taken" | "no-ipv6"> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve(host === "::" && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") ? "no-ipv6" : "taken");
    });
    server.listen({ port, host, ipv6Only: false, exclusive: true }, () => server.close(() => resolve("free")));
  });
}

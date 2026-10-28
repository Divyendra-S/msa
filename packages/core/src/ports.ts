import { createServer } from "node:net";

const handedOut = new Set<number>();

/**
 * Finds a free TCP port on 127.0.0.1. Ports handed out by this process are not
 * reused until released, so parallel branches never race for the same one.
 */
export async function allocatePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await probeFreePort();
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error("could not find a free port");
}

export function releasePort(port: number): void {
  handedOut.delete(port);
}

function probeFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

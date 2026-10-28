import assert from "node:assert/strict";
import { createServer } from "node:net";
import { it } from "node:test";
import { allocatePort, isPortFree, releasePort } from "../src/ports.ts";

it("hands out distinct ports outside the ephemeral range until they are released", async () => {
  const ports = await Promise.all(Array.from({ length: 8 }, () => allocatePort()));
  assert.equal(new Set(ports).size, ports.length);
  assert.ok(ports.every((p) => p >= 20_000 && p < 30_000));
  for (const p of ports) releasePort(p);
});

it("sees a port as taken when anything listens on it, even on one address", async () => {
  const port = await allocatePort();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    server.close();
    releasePort(port);
  }
});

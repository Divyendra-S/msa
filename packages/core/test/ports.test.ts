import assert from "node:assert/strict";
import { it } from "node:test";
import { allocatePort, releasePort } from "../src/ports.ts";

it("hands out distinct ports until they are released", async () => {
  const ports = await Promise.all(Array.from({ length: 8 }, () => allocatePort()));
  assert.equal(new Set(ports).size, ports.length);
  for (const p of ports) releasePort(p);
});

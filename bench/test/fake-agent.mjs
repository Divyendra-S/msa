#!/usr/bin/env node
// A stand-in for a coding agent, to try the benchmark without Muse Code:
//   pnpm bench run --cases 09 --setups A --command "node bench/test/fake-agent.mjs {prompt_file}"
// It prints Codex-style JSONL events with token counts, fixes case 09 (another user's order) if it
// is there, and reports it with a reproduction, plus one made-up finding that never reproduces.
// With Wind Tunnel in the folder (setups B and C) the reproduction is an experiment; otherwise a
// script run against the shop by scripts/local.mjs.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const say = (event) => console.log(JSON.stringify(event));
say({ type: "thread.started", thread_id: "fake" });
say({ type: "item.completed", item: { type: "agent_message", text: `Reading the task (${process.argv[2] ?? "no prompt file"})` } });
say({ type: "item.completed", item: { type: "command_execution", command: "cat app/api/orders/[id]/route.ts" } });

const findings = [];
const route = "app/api/orders/[id]/route.ts";
const code = await readFile(route, "utf8");
const buggy = 'const order = await queryOne("SELECT id, status, total_cents, created_at, paid_at FROM orders WHERE id = $1", [\n    Number(id),\n  ]);';
if (code.includes(buggy)) {
  await writeFile(
    route,
    code.replace(
      buggy,
      'const order = await queryOne(\n    "SELECT id, status, total_cents, created_at, paid_at FROM orders WHERE id = $1 AND user_id = $2",\n    [Number(id), user.id],\n  );',
    ),
  );
  const windTunnel = existsSync("windtunnel.config.yaml");
  if (windTunnel) await writeExperiment();
  else await writeScript();
  findings.push({
    title: "Any logged-in user can read any order by id",
    summary: "GET /api/orders/[id] looks the order up by id only.",
    files: [route],
    reproduce: windTunnel ? "windtunnel run order-peek --repeat 1" : 'node scripts/local.mjs --port 3301 --exec "node repro/order-of-another-user.mjs"',
    fixed: true,
  });
  say({ type: "item.completed", item: { type: "file_change", changes: [{ path: route, kind: "update" }] } });
}
findings.push({ title: "Cart totals round wrongly", files: ["lib/cart.ts"], reproduce: "true", fixed: false });
await writeFile("bench-report.json", `${JSON.stringify({ findings }, null, 2)}\n`);
say({ type: "item.completed", item: { type: "agent_message", text: `Reported ${findings.length} finding(s)${existsSync("repro") ? " with a reproduction" : ""}.` } });
say({ type: "turn.completed", usage: { input_tokens: 12000, cached_input_tokens: 3000, output_tokens: 800 } });

async function writeScript() {
  await mkdir("repro", { recursive: true });
  await writeFile(
    "repro/order-of-another-user.mjs",
    `// Alice orders; Bob asks for her order. Exits 1 if he gets it.
const base = process.env.BASE_URL;
async function session(email) {
  const res = await fetch(base + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "test" }) });
  return res.headers.get("set-cookie").split(";")[0];
}
const post = (cookie, path, body) => fetch(base + path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const alice = await session("alice@example.test");
await post(alice, "/api/cart/items", { productId: 1, quantity: 1 });
const { orderId } = await post(alice, "/api/orders", {});
const bob = await session("bob@example.test");
const res = await fetch(base + "/api/orders/" + orderId, { headers: { cookie: bob } });
console.log("bob asked for order " + orderId + ": " + res.status);
process.exit(res.status === 200 ? 1 : 0);
`,
  );
}

async function writeExperiment() {
  await mkdir(".windtunnel/flows", { recursive: true });
  await mkdir(".windtunnel/experiments", { recursive: true });
  await writeFile(
    ".windtunnel/flows/buy.ts",
    `import { flow } from "windtunnel";

export default flow(async ({ page, step, login }) => {
  await login();
  await step("add-item", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await page.getByText("Added").first().waitFor();
  });
  await step("open-cart", () => page.goto("/cart"));
  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());
  await step("confirmation", () => page.getByText("Order confirmed").waitFor());
});
`,
  );
  await writeFile(
    ".windtunnel/experiments/order-peek.yaml",
    "flow: buy\nperturb:\n  - { do: replay-as, request: GET /api/orders/:id, user: bob }\nwebhooks: { delay: 1s }\n",
  );
  await writeFile(
    ".windtunnel/rules.yaml",
    `orders-only-for-their-buyer:
  sql: >-
    SELECT r.path FROM windtunnel_requests r JOIN users u ON u.email = r.user_email
    JOIN orders o ON o.id = substring(r.path from '^/api/orders/(\\d+)$')::int
    WHERE r.status = 200 AND o.user_id <> u.id
`,
  );
}

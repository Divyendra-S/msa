// A tiny app with no guards at all, as a git repository Wind Tunnel can run: a page with a
// "Send" button whose POST inserts a row and charges the mock payment provider.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgServer } from "../src/branches/postgres.ts";

export const PG_URL = process.env.WT_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";

// Sends are not guarded in any way: no disabled button, no idempotency, no webhook dedupe.
// A successful send navigates to /done, like a checkout going to its confirmation page.
export const SERVER = `const http = require("node:http");
const { Pool } = require(process.env.WT_TEST_PG_MODULE);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const PAY = process.env.PAYMENT_API_URL;
const html = (body) => "<!doctype html><html><body>" + body + '<p id="year"></p>' +
  '<script>document.getElementById("year").textContent = "year " + new Date().getUTCFullYear();</script></body></html>';
const read = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const sid = (req) => { const m = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie || ""); return m ? decodeURIComponent(m[1]) : null; };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const user = sid(req);
    if (req.method === "GET" && url.pathname === "/login") {
      res.setHeader("content-type", "text/html");
      return res.end(html('<form method="post" action="/login"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button>Log in</button></form>'));
    }
    if (req.method === "POST" && url.pathname === "/login") {
      const form = new URLSearchParams(await read(req));
      res.writeHead(303, { "set-cookie": "sid=" + encodeURIComponent(form.get("email")) + "; Path=/; HttpOnly", location: "/" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("content-type", "text/html");
      return res.end(html('<p>user: ' + (user || "nobody") + '</p><button id="send">Send</button><p id="status"></p>' +
        '<script>document.getElementById("send").onclick = async () => { const s = document.getElementById("status"); s.textContent = "Sending";' +
        'try { const r = await fetch("/api/send", { method: "POST" }); if (r.ok) location.href = "/done?id=" + (await r.json()).id; else s.textContent = "Failed " + r.status; }' +
        'catch { s.textContent = "Network error"; } };</script>'));
    }
    if (req.method === "GET" && url.pathname === "/done") {
      res.setHeader("content-type", "text/html");
      return res.end(html("<p>Sent " + Number(url.searchParams.get("id")) + "</p>"));
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      if (!user) { res.writeHead(401); return res.end("{}"); }
      await new Promise((r) => setTimeout(r, 30));
      const { rows } = await pool.query("INSERT INTO hits (who) VALUES ($1) RETURNING id", [user]);
      if (PAY) await fetch(PAY + "/v1/charges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 100 }) });
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: rows[0].id }));
    }
    if (req.method === "POST" && url.pathname === "/hook") {
      const event = JSON.parse(await read(req));
      await pool.query("INSERT INTO hooks (event_id) VALUES ($1)", [event.id]);
      return res.end("ok");
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    res.writeHead(500);
    res.end(String(err));
  }
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

export const SEED = `const { Client } = require(process.env.WT_TEST_PG_MODULE);
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("CREATE TABLE hits (id serial PRIMARY KEY, who text NOT NULL)");
  await db.query("CREATE TABLE hooks (id serial PRIMARY KEY, event_id text NOT NULL)");
  await db.end();
})();
`;

export const CONFIG = `app:
  start: node server.cjs
  env:
    PAYMENT_API_URL: $MOCK_PAY_URL
db:
  kind: postgres
  url: ${PG_URL}
  seed: node seed.cjs
mockPay:
  webhookPath: /hook
  webhookDelayMs: 20
users:
  alice: { email: alice@example.test, password: a }
  bob: { email: bob@example.test, password: b }
parallel: 4
`;

// at-most-one-hit compares with the seed copy every run's database holds.
export const RULES = `at-most-one-hit:
  sql: SELECT count(*) AS hits FROM hits HAVING count(*) - (SELECT count(*) FROM windtunnel_seed.hits) > 1
one-hook-per-event:
  sql: SELECT event_id, count(*) AS deliveries FROM hooks GROUP BY event_id HAVING count(*) > 1
`;

export const LOGIN_FLOW = `import { flow } from "windtunnel";

export default flow(async ({ page, user }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/");
});
`;

export const SEND_FLOW = `import { flow } from "windtunnel";

export default flow(async ({ page, step, login, params }) => {
  await login();
  await step("open", () => page.goto("/"));
  await step("send", () => page.getByRole("button", { name: "Send" }).click());
  await step("result", () => page.getByText(new RegExp(params.expect ?? "^Sent \\\\d+$")).waitFor());
});
`;

export async function pgAvailable(): Promise<boolean> {
  const probe = new PgServer(PG_URL);
  try {
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** Writes the app, its flows and the given experiments to a new git repository; returns its path. */
export async function createFixtureRepo(experiments: Record<string, string>, extra: Record<string, string> = {}): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-fixture-")));
  process.env.WT_TEST_PG_MODULE = createRequire(import.meta.url).resolve("pg");
  const files: Record<string, string> = {
    "server.cjs": SERVER,
    "seed.cjs": SEED,
    "windtunnel.config.yaml": CONFIG,
    ".windtunnel/rules.yaml": RULES,
    ".windtunnel/flows/login.ts": LOGIN_FLOW,
    ".windtunnel/flows/send.ts": SEND_FLOW,
    ...Object.fromEntries(Object.entries(experiments).map(([id, text]) => [`.windtunnel/experiments/${id}.yaml`, `${text}\nrepeat: 1\n`])),
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

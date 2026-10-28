// Integration test for the experiment runner: one experiment per perturbation
// against a tiny app with no guards. Needs the development Postgres (`pnpm db:up`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PgServer } from "../src/branches/postgres.ts";
import { clean } from "../src/cleanup.ts";
import { ConfigError } from "../src/config.ts";
import type { DbDiff } from "../src/runner/db-diff.ts";
import { loadExperiments, parseExperiment } from "../src/runner/experiment.ts";
import type { RequestRecord } from "../src/runner/network.ts";
import type { StepRecord } from "../src/runner/rep.ts";
import { type ExperimentResult, Runner } from "../src/runner/runner.ts";

const PG_URL = process.env.WT_TEST_PG_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";

// Sends are not guarded in any way: no disabled button, no idempotency, no webhook dedupe.
// A successful send navigates to /done, like a checkout going to its confirmation page.
const SERVER = `const http = require("node:http");
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

const SEED = `const { Client } = require(process.env.WT_TEST_PG_MODULE);
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("CREATE TABLE hits (id serial PRIMARY KEY, who text NOT NULL)");
  await db.query("CREATE TABLE hooks (id serial PRIMARY KEY, event_id text NOT NULL)");
  await db.end();
})();
`;

const CONFIG = `app:
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

const RULES = `at-most-one-hit:
  sql: SELECT count(*) AS hits FROM hits HAVING count(*) > 1
one-hook-per-event:
  sql: SELECT event_id, count(*) AS deliveries FROM hooks GROUP BY event_id HAVING count(*) > 1
`;

const LOGIN_FLOW = `import { flow } from "windtunnel";

export default flow(async ({ page, user }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/");
});
`;

const SEND_FLOW = `import { flow } from "windtunnel";

export default flow(async ({ page, step, login, params }) => {
  await login();
  await step("open", () => page.goto("/"));
  await step("send", () => page.getByRole("button", { name: "Send" }).click());
  await step("result", () => page.getByText(new RegExp(params.expect ?? "^Sent \\\\d+$")).waitFor());
});
`;

const EXPERIMENTS: Record<string, string> = {
  plain: "flow: send",
  "double-submit": "flow: send\nperturb: [{ do: double-submit, step: send }]",
  "fail-503": `flow: send
params: { expect: "^Failed 503$" }
perturb: [{ do: fail, request: POST /api/send }]`,
  "lost-response": `flow: send
perturb:
  - { do: lose-response, request: POST /api/send, step: send }
  - { do: repeat, step: send }`,
  duplicate: "flow: send\nperturb: [{ do: duplicate, request: POST /api/send }]",
  delay: "flow: send\nperturb: [{ do: delay, request: POST /api/send, ms: 400ms }]",
  "expired-session": `flow: send
params: { expect: "^Failed 401$" }
perturb: [{ do: expire-session, step: send, cookie: sid }]`,
  refresh: `flow: send
params: { expect: "^user: " }
perturb: [{ do: refresh, step: send }]`,
  "back-resubmit": "flow: send\nperturb: [{ do: back-resubmit, step: send }]",
  "second-tab": `flow: send
perturb: [{ do: second-tab, step: send }]
race: { request: POST /api/send }`,
  "ordered-race": `flow: send
users: [alice, bob]
race: { request: POST /api/send, order: [bob, alice] }`,
  "every-order": `flow: send
users: [alice, bob]
race: { request: POST /api/send, order: each }`,
  clock: `flow: send
clock: 2031-05-01T00:00:00Z
params: { expect: "^year 2032$" }
perturb: [{ do: advance-clock, step: open, by: 400d }]`,
  "duplicate-webhook": "flow: send\nwebhooks: duplicate",
  "late-webhook": "flow: send\nwebhooks: late",
  "out-of-order-webhooks": `flow: send
users: [alice, bob]
race: { request: POST /api/send }
webhooks: out-of-order`,
};

async function pgAvailable(): Promise<boolean> {
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

describe("runner", { skip: !(await pgAvailable()) && "Postgres not reachable (pnpm db:up)" }, () => {
  let repo: string;
  let cache: string;
  let runner: Runner;
  const results = new Map<string, ExperimentResult>();

  async function repFile<T>(id: string, file: string, rep = 1): Promise<T> {
    const result = results.get(id);
    assert.ok(result, `no result for ${id}`);
    return JSON.parse(await readFile(join(result.dir, "reps", String(rep), file), "utf8")) as T;
  }

  const assertOutcome = (id: string, expected: string) => {
    const result = results.get(id);
    assert.ok(result, `no result for ${id}`);
    const error = result.variants.find((v) => v.firstError)?.firstError?.message;
    assert.equal(result.outcome, expected, `${id}${error ? `: ${error}` : ""}`);
  };

  const sendRequests = async (id: string, rep = 1) =>
    (await repFile<RequestRecord[]>(id, "requests.json", rep)).filter((r) => r.method === "POST" && r.url === "/api/send");
  const addedHits = async (id: string, rep = 1) =>
    (await repFile<DbDiff>(id, "db-diff.json", rep)).tables.hits?.added ?? [];

  before(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "wt-runner-")));
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    process.env.WINDTUNNEL_CACHE_DIR = cache;
    process.env.WT_TEST_PG_MODULE = createRequire(import.meta.url).resolve("pg");
    await writeFile(join(repo, "server.cjs"), SERVER);
    await writeFile(join(repo, "seed.cjs"), SEED);
    await writeFile(join(repo, "windtunnel.config.yaml"), CONFIG);
    await mkdir(join(repo, ".windtunnel", "flows"), { recursive: true });
    await mkdir(join(repo, ".windtunnel", "experiments"), { recursive: true });
    await writeFile(join(repo, ".windtunnel", "rules.yaml"), RULES);
    await writeFile(join(repo, ".windtunnel", "flows", "login.ts"), LOGIN_FLOW);
    await writeFile(join(repo, ".windtunnel", "flows", "send.ts"), SEND_FLOW);
    for (const [id, text] of Object.entries(EXPERIMENTS)) {
      await writeFile(join(repo, ".windtunnel", "experiments", `${id}.yaml`), `${text}\nrepeat: 1\n`);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "t");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    runner = await Runner.open(repo);
    for (const result of await runner.run(await loadExperiments(runner.project))) results.set(result.experiment, result);
  });

  after(async () => {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("runs a flow step by step and records requests and database changes", async () => {
    const result = results.get("plain")!;
    assert.equal(result.outcome, "pass");
    assert.equal(result.reps[0]!.diff, "hits +1 · hooks +1");
    const steps = await repFile<{ steps: StepRecord[] }>("plain", "result.json");
    assert.deepEqual(
      steps.steps.map((s) => s.step),
      ["login", "open", "send", "result"],
    );
    assert.ok(steps.steps.every((s) => s.quiet));
    const [send] = await sendRequests("plain");
    assert.equal(send?.step, "send");
    assert.equal(send?.status, 200);
    assert.deepEqual(await addedHits("plain"), [{ id: 1, who: "alice@example.test" }]);
  });

  it("double submit sends two requests when nothing guards the button", async () => {
    const result = results.get("double-submit")!;
    assert.equal(result.outcome, "fail");
    assert.deepEqual(result.reps[0]!.broken, ["at-most-one-hit"]);
    assert.equal((await sendRequests("double-submit")).length, 2);
  });

  it("network perturbations: 5xx, lost response + retry, duplicate, delay", async () => {
    assertOutcome("fail-503", "pass");
    assert.equal((await addedHits("fail-503")).length, 0, "the app never saw the request");
    assert.match((await sendRequests("fail-503"))[0]!.harness!.join(), /answered 503/);

    assertOutcome("lost-response", "fail");
    const lost = await sendRequests("lost-response");
    assert.equal(lost.length, 2);
    assert.match(lost[0]!.harness!.join(), /response lost/);
    assert.equal(lost[0]!.failure, "net::ERR_CONNECTION_RESET");

    assertOutcome("duplicate", "fail");
    assert.equal((await addedHits("duplicate")).length, 2);

    const { steps } = await repFile<{ steps: StepRecord[] }>("delay", "result.json");
    const send = steps.find((s) => s.step === "send")!;
    assert.ok(send.end - send.start >= 400, `send step took ${send.end - send.start} ms`);
  });

  it("browser perturbations: expired session, refresh, back + resubmit, second tab", async () => {
    assertOutcome("expired-session", "pass");
    assert.equal((await addedHits("expired-session")).length, 0);

    assertOutcome("refresh", "pass");
    assert.equal((await addedHits("refresh")).length, 1, "the app handled the request the user refreshed away from");
    const refresh = await repFile<{ steps: StepRecord[] }>("refresh", "result.json");
    assert.match(refresh.steps.find((s) => s.step === "send")!.harness!.join(), /refreshed/);

    assertOutcome("back-resubmit", "fail");
    const back = await repFile<{ steps: StepRecord[] }>("back-resubmit", "result.json");
    assert.deepEqual(
      back.steps.filter((s) => s.step === "send").map((s) => s.attempt ?? "first"),
      ["first", "resubmit"],
    );

    assertOutcome("second-tab", "fail");
    const tabs = await repFile<{ race: { arrived: { tab: string }[] } }>("second-tab", "result.json");
    assert.deepEqual(tabs.race.arrived.map((a) => a.tab).sort(), ["alice", "alice#2"]);
  });

  it("ordered races release requests in the chosen order; `each` runs every order", async () => {
    assertOutcome("ordered-race", "fail");
    const hits = await addedHits("ordered-race");
    assert.deepEqual(
      hits.map((h) => h.who),
      ["bob@example.test", "alice@example.test"],
      "bob's request was released (and answered) first",
    );

    const every = results.get("every-order")!;
    assert.deepEqual(
      every.variants.map((v) => v.variant),
      ["together", "alice,bob", "bob,alice"],
    );
    for (const rep of every.reps.filter((r) => r.variant !== "together")) {
      const who = (await addedHits("every-order", rep.rep)).map((h) => String(h.who).split("@")[0]).join(",");
      assert.equal(who, rep.variant);
    }
  });

  it("fake clock: fixed start time, advanced before a step", async () => {
    const result = results.get("clock")!;
    assert.equal(result.outcome, "pass", result.variants[0]!.firstError?.message);
  });

  it("webhook control: duplicate, late, out of order", async () => {
    assertOutcome("duplicate-webhook", "fail");
    assert.deepEqual(results.get("duplicate-webhook")!.reps[0]!.broken, ["one-hook-per-event"]);

    const late = await repFile<{ startedAt: string; steps: StepRecord[]; webhooks: { deliveries: { at: string }[] }[] }>(
      "late-webhook",
      "result.json",
    );
    const sendEnd = Date.parse(late.startedAt) + late.steps.find((s) => s.step === "send")!.end;
    assert.ok(Date.parse(late.webhooks[0]!.deliveries[0]!.at) >= sendEnd - 5, "delivered after the send step");

    const ooo = await repFile<{ webhooks: { event: string; deliveries: { at: string }[] }[] }>(
      "out-of-order-webhooks",
      "result.json",
    );
    const order = [...ooo.webhooks].sort((a, b) => Date.parse(a.deliveries[0]!.at) - Date.parse(b.deliveries[0]!.at));
    assert.deepEqual(
      order.map((w) => w.event),
      ["evt_0002", "evt_0001"],
    );
  });

  it("keeps a run store with an index", async () => {
    const entries = await runner.store.list(100);
    assert.equal(entries.length, Object.keys(EXPERIMENTS).length);
    const summary = (await runner.store.read(results.get("plain")!.runId)) as ExperimentResult;
    assert.equal(summary.outcome, "pass");
  });

  it("rejects experiments that name unknown steps, users or rules", async () => {
    const bad = parseExperiment(
      "flow: send\nusers: [carol]\nperturb: [{ do: repeat, step: pay }]\nrules: [nope]",
      "bad.yaml",
      "bad",
    );
    await assert.rejects(runner.validate([bad]), (err: Error) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /unknown user "carol"/);
      assert.match(err.message, /step "pay" is not in flow "send"/);
      assert.match(err.message, /unknown rule "nope"/);
      return true;
    });
  });
});

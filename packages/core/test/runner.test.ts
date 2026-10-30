// Integration test for the experiment runner: one experiment per perturbation
// against a tiny app with no guards. Needs the development Postgres (`pnpm db:up`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clean } from "../src/cleanup.ts";
import { ConfigError } from "../src/config.ts";
import type { DbDiff } from "../src/runner/db-diff.ts";
import { loadExperiments, parseExperiment } from "../src/runner/experiment.ts";
import type { RequestRecord } from "../src/runner/network.ts";
import type { StepRecord } from "../src/runner/rep.ts";
import { drillDown, evidencePacket, PACKET_CHARS } from "../src/runner/evidence.ts";
import { formatResults } from "../src/runner/report.ts";
import { writeProofBranch } from "../src/runner/proof-branch.ts";
import { prove } from "../src/runner/prove.ts";
import { type ExperimentResult, Runner } from "../src/runner/runner.ts";
import { loadRules } from "../src/rules.ts";
import { CONFIG, createFixtureRepo, pgAvailable, RULES, SEED, SERVER } from "./fixture.ts";

// The project's own tests: they use the seed copy they are given.
const TESTS = `const { Client } = require(process.env.WT_TEST_PG_MODULE);
(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  await db.query("SELECT count(*) FROM hits");
  await db.end();
  console.log("tests pass");
})().catch((err) => { console.error(err.message); process.exit(1); });
`;

// Rules on what users got and saw (the run's requests and pages, next to the app's tables).
const FACT_RULES = `replays-refused:
  sql: SELECT id, user_name, status FROM windtunnel_requests WHERE harness LIKE '%sent again with%' AND status < 400
no-502-shown:
  sql: SELECT tab, step FROM windtunnel_pages WHERE text LIKE '%Failed 502%' AND user_email = 'alice@example.test'
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
  "fail-after": `flow: send
params: { expect: "^Failed 502$" }
perturb: [{ do: fail, request: POST /api/send, status: 502, after: 400ms }]`,
  "replay-as": "flow: send\nperturb: [{ do: replay-as, request: POST /api/send, user: bob }]",
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
  "sql-state": `flow: send
perturb: [{ do: sql, step: send, sql: "INSERT INTO hits (who) VALUES ('ghost')" }]`,
  "second-tab-order": `flow: send
perturb: [{ do: second-tab, step: send }]
race: { request: POST /api/send, order: ["alice#2", alice] }`,
  "webhook-delay": "flow: send\nwebhooks: { delay: 700ms }",
  "not-exercised": `flow: send
perturb: [{ do: lose-response, request: POST /api/nothing }]
race: { request: GET /nowhere, timeout: 200ms }
webhooks: out-of-order`,
  "duplicate-webhook": "flow: send\nwebhooks: duplicate",
  "late-webhook": "flow: send\nwebhooks: late",
  "out-of-order-webhooks": `flow: send
users: [alice, bob]
race: { request: POST /api/send }
webhooks: out-of-order`,
};

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
    repo = await createFixtureRepo(EXPERIMENTS, {
      "windtunnel.config.yaml": CONFIG.replace("app:\n", "app:\n  test: node tests.cjs\n"),
      "tests.cjs": TESTS,
      ".windtunnel/rules.yaml": RULES + FACT_RULES,
    });
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    process.env.WINDTUNNEL_CACHE_DIR = cache;

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

  it("rules read what users got and saw: a request replayed as another user, a page after a slow failure", async () => {
    assertOutcome("replay-as", "fail");
    assert.deepEqual([...results.get("replay-as")!.reps[0]!.broken].sort(), ["at-most-one-hit", "replays-refused"]);
    const requests = await repFile<RequestRecord[]>("replay-as", "requests.json");
    const replay = requests.find((r) => r.tab === "bob (replay)");
    assert.ok(replay, "the replay is in the request log");
    assert.equal(replay.user, "bob");
    assert.equal(replay.status, 200);
    assert.equal(replay.step, "send");
    const original = requests.find((r) => r.tab === "alice" && r.url === "/api/send")!;
    assert.match(original.harness!.join(), new RegExp(`replayed as bob \\(request ${replay.id}\\): 200`));
    assert.deepEqual((await addedHits("replay-as")).map((h) => h.who), ["alice@example.test", "bob@example.test"]);

    assertOutcome("fail-after", "fail");
    assert.deepEqual(results.get("fail-after")!.reps[0]!.broken, ["no-502-shown"]);
    const [send] = await sendRequests("fail-after");
    assert.match(send!.harness!.join(), /answered 502 after 400 ms/);
    assert.ok(send!.end! - send!.start >= 400, `answered after ${send!.end! - send!.start} ms`);
    const { steps } = await repFile<{ steps: StepRecord[] }>("fail-after", "result.json");
    assert.match(steps.find((s) => s.step === "result")!.seen!.text, /Failed 502/);
    assert.equal(steps.find((s) => s.step === "result")!.seen!.path, "/");
    // Each step leaves a screenshot of its tab.
    const shot = steps.find((s) => s.step === "result")!.shot;
    assert.match(shot ?? "", /^step-\d+-alice\.jpg$/);
    const jpeg = await readFile(join(results.get("fail-after")!.dir, "reps", "1", "screens", shot!));
    assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
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

  it("sql perturbation changes the run's database before the step", async () => {
    assertOutcome("sql-state", "fail");
    const { steps } = await repFile<{ steps: StepRecord[] }>("sql-state", "result.json");
    const send = steps.find((step) => step.step === "send")!;
    assert.match(send.harness?.join(" ") ?? "", /ran SQL \(1 row\(s\)\): INSERT INTO hits/);
    assert.deepEqual((await addedHits("sql-state")).map((h) => h.who).sort(), ["alice@example.test", "ghost"]);
  });

  it("races can name the second tab in their order", async () => {
    assertOutcome("second-tab-order", "fail");
    const requests = await sendRequests("second-tab-order");
    const byTab = Object.fromEntries(requests.map((r) => [r.tab, r]));
    assert.ok(byTab["alice#2"] && byTab.alice, "both tabs sent");
    assert.ok(byTab["alice#2"]!.end! <= byTab.alice!.end!, "the second tab's request was released and answered first");
  });

  it("delays webhooks by a fixed time", async () => {
    assertOutcome("webhook-delay", "pass");
    const [send] = await sendRequests("webhook-delay");
    const { startedAt, webhooks } = await repFile<{ startedAt: string; webhooks: { deliveries: { at: string }[] }[] }>("webhook-delay", "result.json");
    const deliveredAt = Date.parse(webhooks[0]!.deliveries[0]!.at) - Date.parse(startedAt);
    assert.ok(deliveredAt - send!.end! >= 650, `delivered ${deliveredAt - send!.end!} ms after the charge`);
  });

  it("warns about parts of an experiment that never took effect", async () => {
    const result = results.get("not-exercised")!;
    assert.equal(result.outcome, "pass");
    assert.deepEqual(result.warnings, [
      "lose-response POST /api/nothing: no request matched (1/1 runs)",
      "race on GET /nowhere: no request matched, nothing was held (1/1 runs)",
      "webhooks out-of-order: never more than one event at a time, nothing was reordered (1/1 runs)",
    ]);
    assert.match(formatResults([result]), /not exercised \(a pass here proves less\):\n {2}not-exercised: lose-response POST \/api\/nothing: no request matched/);
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

  it("evidence packet: broken rule, harness notes, short, with drill-down handles", async () => {
    const result = results.get("lost-response")!;
    const rules = await loadRules(runner.project);
    const packet = await evidencePacket(runner.store, result.runId, {
      rules,
      handlerFor: (m, p) => (p === "/api/send" ? "server.cjs" : undefined),
      source: runner.project,
    });
    assert.ok(packet.length < PACKET_CHARS, `packet is ${packet.length} chars`);
    assert.match(packet, /Result: FAIL — at-most-one-hit broken in 1\/1 runs/);
    assert.match(packet, /Rule at-most-one-hit broken/);
    assert.match(packet, /\[harness\] response lost/);
    assert.match(packet, /POST \/api\/send → server\.cjs/);
    assert.match(packet, /hits: \+\{id: 1, who: alice@example\.test\} \+\{id: 2/);
    // The trace chain: the rule's table → the statements that wrote it → the request and its handler.
    assert.match(packet, /Trace \(request → handler → SQL → result\) of the tables the broken rules read/);
    // With the line of the SQL in the code the run used, the connection, and no transaction around it.
    assert.match(packet, /hits \(\+2\):\n {4}\d+ alice POST \/api\/send → server\.cjs:\d+: INSERT INTO hits \(who\) VALUES \(\$1\) RETURNING id \[alice@example\.test\] → INSERT 0 1 \(c\d+, no tx\)/);
    assert.match(packet, /POST \/api\/send ✗ net::ERR_CONNECTION_RESET · SQL \d+, \d writes? \[harness\]/);
    assert.match(await drillDown(runner.store, `${result.runId}/1/sql:hits`), /INSERT INTO hits .* → INSERT 0 1 \(c\d+, no tx, \d+ ms\)/);

    const requests = await drillDown(runner.store, `${result.runId}/1/requests`, { rules });
    assert.match(requests, /alice \/ send POST \/api\/send ✗ net::ERR_CONNECTION_RESET · SQL \d+, \d writes? \[harness\]/);
    assert.match(await drillDown(runner.store, `${result.runId}/1/diff:hits`), /hits: \+/);
    assert.match(await drillDown(runner.store, `${result.runId}/1/rule:at-most-one-hit`, { rules }), /SQL: SELECT count\(\*\)/);
    await assert.rejects(drillDown(runner.store, `${result.runId}/1/nope`), /unknown handle part "nope"/);
    await assert.rejects(drillDown(runner.store, `${result.runId}/9`), /has runs 1–1/);
  });

  it("proves a real fix and rejects a wrong one", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString();
    const patchFor = async (server: string, seed: string) => {
      await writeFile(join(repo, "server.cjs"), server);
      await writeFile(join(repo, "seed.cjs"), seed);
      const diff = git("diff");
      git("checkout", "--", ".");
      return diff;
    };
    const insert = `await pool.query("INSERT INTO hits (who) VALUES ($1) RETURNING id", [user]);`;
    // Real fix: one row per user, enforced by the database.
    const fix = await patchFor(
      SERVER.replace(insert, `await pool.query("INSERT INTO hits (who) VALUES ($1) ON CONFLICT (who) DO UPDATE SET who = EXCLUDED.who RETURNING id", [user]);`),
      SEED.replace("who text NOT NULL)", "who text NOT NULL UNIQUE)"),
    );
    // Wrong fix: check first, then insert; both requests pass the check.
    const wrong = await patchFor(
      SERVER.replace("await new Promise((r) => setTimeout(r, 30));", `const seen = await pool.query("SELECT 1 FROM hits WHERE who = $1", [user]); if (seen.rowCount) { res.end('{"id":0}'); return; } await new Promise((r) => setTimeout(r, 30));`),
      SEED,
    );
    const all = await loadExperiments(runner.project);
    const target = all.filter((e) => e.id === "double-submit");
    const regression = all.filter((e) => e.id === "plain" || e.id === "fail-503");

    const good = await prove(runner, { experiments: target, fix: { patch: fix }, repeat: 2, regression });
    assert.equal(good.verdict, "proven", good.reasons.join("; "));
    assert.equal(good.base.results[0]!.outcome, "fail");
    assert.equal(good.fix.results[0]!.outcome, "pass");
    assert.equal(good.revert[0]!.outcome, "fail");
    assert.deepEqual(good.regression.map((r) => `${r.experiment} ${r.base}→${r.fix}`).sort(), ["fail-503 pass→pass", "plain pass→pass"]);

    // The base's evidence now points at the fix's passing run of the same experiment.
    const packet = await evidencePacket(runner.store, good.revert[0]!.runId);
    assert.match(packet, new RegExp(`Compared with passing run ${good.fix.results[0]!.runId} on version ${good.fix.version.id}`));
    assert.match(packet, /database changes there: hits \+1/);

    // The project's tests ran on both versions, each with its own seed copy.
    assert.equal(good.tests?.base.ok, true, good.tests?.base.tail.join("\n"));
    assert.equal(good.tests?.fix.ok, true, good.tests?.fix.tail.join("\n"));

    // Proving the same thing again reuses the proof; the branch is built from it.
    const again = await prove(runner, { experiments: target, fix: { patch: fix }, repeat: 2, regression, reuse: true });
    assert.ok(again.reused);
    const rules = await loadRules(runner.project);
    const branch = await writeProofBranch(runner, again, { name: "windtunnel/fix-double-submit", experiments: target, rules });
    // Committed experiment files are kept as they are; the state folder's .gitignore wasn't committed yet.
    assert.deepEqual(branch.added, [".windtunnel/.gitignore", ".windtunnel/evidence/double-submit.md"]);
    assert.deepEqual(git("show", "--name-only", "--format=", branch.name).trim().split("\n").sort(), [".windtunnel/.gitignore", ".windtunnel/evidence/double-submit.md", "seed.cjs", "server.cjs"]);
    assert.equal(git("log", "-1", "--format=%s", branch.name).trim(), "Fix at-most-one-hit (double-submit)");
    const evidence = git("show", `${branch.name}:.windtunnel/evidence/double-submit.md`);
    assert.match(evidence, /\| `double-submit` \| fix \| working tree \+ patch @ [0-9a-f]{12} \| PASS \| 2\/2 runs held every rule \|/);
    assert.match(evidence, /Project tests \(`node tests\.cjs`\): pass on the base, pass with the fix/);
    // The working tree and the current branch are left alone.
    assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(git("branch", "--show-current").trim(), "main");
    await assert.rejects(writeProofBranch(runner, again, { name: branch.name, experiments: target }), /already exists/);

    const bad = await prove(runner, { experiments: target, fix: { patch: wrong }, repeat: 2, regression });
    assert.equal(bad.verdict, "not proven");
    assert.match(bad.reasons.join("\n"), /double-submit still fails with the fix/);
    await assert.rejects(writeProofBranch(runner, bad, { name: "windtunnel/wrong", experiments: target }), /not proven/);
  });
});

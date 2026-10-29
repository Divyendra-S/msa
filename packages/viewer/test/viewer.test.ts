// The viewer's local API on a run store written by hand (no Postgres or browser needed): access
// checks, runs and their details, the aligned comparison, and a hunt started with a fake `muse`.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFIG, createFixtureRepo } from "../../core/test/fixture.ts";
import { readEvent } from "../src/hunt.ts";
import { startViewer, type Viewer } from "../src/server.ts";

const FAKE_MUSE = join(import.meta.dirname, "fake-muse.mjs");
const RUN = "261029-100000-aaaa";
const OPEN = "261029-100500-bbbb";

describe("viewer", () => {
  let repo: string;
  let viewer: Viewer;
  const env = { ...process.env, MODEL_API_KEY: "meta-test-key", ANTHROPIC_API_KEY: "must-not-pass", OPENAI_API_KEY: "must-not-pass" };
  const get = async (path: string, headers: Record<string, string> = {}) =>
    fetch(`${viewer.url}${path}`, { headers: { "x-windtunnel-token": viewer.token, ...headers }, redirect: "manual" });
  const json = async <T = any>(path: string): Promise<T> => {
    const res = await get(path);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${viewer.url}${path}`, {
      method: "POST",
      headers: { "x-windtunnel-token": viewer.token, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  before(async () => {
    repo = await createFixtureRepo({}, { "windtunnel.config.yaml": `${CONFIG}hunt:\n  command: ["${process.execPath}", "${FAKE_MUSE}"]\n  skill: windtunnel-hunt\n` });
    await writeStore(join(repo, ".windtunnel", "runs"));
    viewer = await startViewer({ cwd: repo, port: 0, env, distDir: join(repo, "no-ui") });
  });

  after(async () => {
    await viewer?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
  });

  it("answers only local pages that hold the session token", async () => {
    assert.equal((await fetch(`${viewer.url}/api/status`)).status, 401);
    assert.equal((await get("/api/status", { "x-windtunnel-token": "nope" })).status, 401);
    // A name that resolves to 127.0.0.1 (DNS rebinding) is refused even with the token. (fetch can't set Host.)
    const rebound = await new Promise<number>((resolve, reject) => {
      request(`${viewer.url}/api/status`, { headers: { host: `evil.example:${viewer.port}`, "x-windtunnel-token": viewer.token } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
        .on("error", reject)
        .end();
    });
    assert.equal(rebound, 403);
    const open = await fetch(viewer.openUrl, { redirect: "manual" });
    assert.equal(open.status, 302);
    const cookie = open.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^wt_viewer_${viewer.port}=${viewer.token}; HttpOnly; SameSite=Strict`));
    const withCookie = await fetch(`${viewer.url}/api/status`, { headers: { cookie: cookie.split(";")[0]! } });
    assert.equal(withCookie.status, 200);
    assert.equal((await fetch(`${viewer.url}/?token=stale`, { redirect: "manual" })).status, 403);
    // A form post from another site can't send JSON, and a cross-origin fetch is refused.
    assert.equal((await fetch(`${viewer.url}/api/hunts`, { method: "POST", headers: { "x-windtunnel-token": viewer.token }, body: "prompt=x" })).status, 415);
    assert.equal((await post("/api/hunts", { prompt: "x" }, { origin: "https://evil.example" })).status, 403);
    // No UI built at distDir: the page says how to build it.
    const page = await fetch(`${viewer.url}/`);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /pnpm viewer:build/);
    assert.equal((await fetch(`${viewer.url}/..%2f..%2fpackage.json`)).status, 404);
  });

  it("lists runs, with one still going, and leaves its address for links", async () => {
    const status = await json("/api/status");
    assert.equal(status.project.root, repo);
    assert.equal(status.hunt.ok, true);
    const runs = await json<{ id: string; outcome: string; running?: { done: number; total: number } }[]>("/api/runs");
    assert.deepEqual(runs.map((r) => [r.id, r.outcome, r.running]), [
      [OPEN, "running", { done: 1, total: 2 }],
      [RUN, "flaky", undefined],
    ]);
    const state = JSON.parse(await readFile(join(repo, ".windtunnel", "cache", "viewer.json"), "utf8"));
    assert.equal(state.port, viewer.port);
    assert.equal(state.pid, process.pid);
    assert.equal((await stat(join(repo, ".windtunnel", "cache", "viewer.json"))).mode & 0o077, 0, "the token file is private");
  });

  it("shows a run, a repetition's trace chain and rules, and where it first differs from one that held", async () => {
    const detail = await json(`/api/runs/${RUN}`);
    assert.equal(detail.focus, 1);
    assert.deepEqual([detail.reference.run, detail.reference.rep], [RUN, 2]);
    const rep = await json(`/api/runs/${RUN}/reps/1`);
    assert.equal(rep.outcome, "broken");
    assert.deepEqual(rep.trace.focus, ["hits"]);
    const hits = rep.trace.tables.find((t: { table: string }) => t.table === "hits");
    assert.deepEqual(hits.events.map((e: { at: number; write?: { op: string } }) => [e.at, e.write?.op]), [[70, "INSERT"], [72, "INSERT"]]);
    assert.deepEqual(hits.events[0].sources[0].who, ["alice"]);
    assert.equal(rep.rules[0].sql.startsWith("SELECT count(*)"), true);
    assert.equal(rep.requests.filter((r: { notable: boolean }) => r.notable).length, 2);

    const c = await json(`/api/compare?lanes=${RUN}/1,${RUN}/2`);
    assert.equal(c.reference, 1);
    assert.deepEqual(c.rows.map((r: { tab: string; step: string }) => `${r.tab}/${r.step}`), ["alice/open", "alice/send"]);
    assert.deepEqual(c.divergence[0], {
      tab: "alice",
      at: 60,
      row: 1,
      ours: "send: POST /api/send 200 [harness] double-clicked",
      theirs: "send: POST /api/send 200",
    });
    assert.equal(c.rows[1].cells[0].requests[0].divergent, true);
    assert.deepEqual(c.rows[1].cells[0].requests[0].sql, { total: 2, writes: 2, errors: 0 });
    assert.equal((await get(`/api/compare?lanes=${RUN}/9`)).status, 404);
    assert.equal((await get("/api/compare?lanes=../x")).status, 400);
  });

  it("gives a run's evidence packet as text", async () => {
    const { text } = await json<{ text: string }>(`/api/runs/${RUN}/evidence`);
    assert.match(text, /send-twice/);
    assert.match(text, /at-most-one-hit/);
    assert.equal((await get("/api/runs/261029-000000-zzzz/evidence")).status, 404);
  });

  it("runs a hunt with the Meta key only, and streams its events", async () => {
    const events = await openEvents(viewer);
    const started = await post("/api/hunts", { prompt: "Use the windtunnel-hunt skill on checkout." });
    assert.equal(started.status, 200);
    const info = (await started.json()) as { id: string };
    const done = await events.until((e) => e.type === "hunt" && e.info.status !== "running");
    events.close();
    assert.equal(done.info.status, "done");
    assert.deepEqual(done.info.usage, { input: 1200, output: 80, cached: 300, usd: 0 });

    const { events: log } = await json(`/api/hunts/${info.id}`);
    const kinds = log.map((e: { kind: string; tool?: string }) => (e.kind === "tool" ? `tool ${e.tool}` : e.kind));
    // stdout and stderr are separate streams: only the stdout order is fixed.
    assert.deepEqual(kinds.filter((k: string) => k !== "stderr"), ["event", "message", "tool windtunnel.windtunnel_map", "output", "message", "usage", "end"]);
    assert.ok(kinds.includes("stderr"));
    const envLine = log.find((e: { text?: string }) => e.text?.startsWith("env "))!.text;
    assert.equal(envLine, `env clean job=hunt-${info.id} key=set prompt=Use the windtunnel-hunt skill on checkout.`);
    assert.equal((await json("/api/hunts"))[0].id, info.id);
  });

  it("stops a hunt, and allows one at a time", async () => {
    const res = await post("/api/hunts", { prompt: "slow hunt" });
    const { id } = (await res.json()) as { id: string };
    assert.equal((await post("/api/hunts", { prompt: "another" })).status, 409);
    const events = await openEvents(viewer);
    await post(`/api/hunts/${id}/stop`, {});
    const end = await events.until((e) => e.type === "hunt" && e.id === id && e.info.status !== "running");
    events.close();
    assert.equal(end.info.status, "stopped");
  });

  it("never starts another agent's CLI from the Run button", async () => {
    await writeFile(join(repo, "windtunnel.config.yaml"), `${CONFIG}hunt:\n  command: [claude, -p]\n`);
    const other = await startViewer({ cwd: repo, port: 0, env, distDir: join(repo, "no-ui") });
    try {
      const res = await fetch(`${other.url}/api/status`, { headers: { "x-windtunnel-token": other.token } });
      const status = (await res.json()) as { hunt: { ok: boolean; reason: string } };
      assert.equal(status.hunt.ok, false);
      assert.match(status.hunt.reason, /only starts Muse Code/);
      const refused = await fetch(`${other.url}/api/hunts`, { method: "POST", headers: { "x-windtunnel-token": other.token, "content-type": "application/json" }, body: '{"prompt":"x"}' });
      assert.equal(refused.status, 412);
    } finally {
      await other.close();
    }
  });

  it("reads agent events whatever their shape", () => {
    assert.deepEqual(readEvent({ type: "item.completed", item: { type: "command_execution", command: "pnpm test" } }), { kind: "tool", type: "item.completed", tool: "shell: pnpm test" });
    assert.deepEqual(readEvent({ type: "assistant", message: { content: [{ type: "text", text: "Looking at orders." }] } }), { kind: "message", type: "assistant", text: "Looking at orders." });
    assert.deepEqual(readEvent({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__windtunnel__windtunnel_run", input: { experiments: ["a"] } }] } }).tool, "mcp__windtunnel__windtunnel_run");
    assert.deepEqual(readEvent({ type: "result", usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.01 }).usage, { input: 10, output: 2, cached: 0, usd: 0.01 });
    assert.deepEqual(readEvent([1, 2]), { kind: "event", text: "1,2" });
  });
});

/** The event stream as a test reads it: wait for the first event that matches. */
async function openEvents(viewer: Viewer) {
  const controller = new AbortController();
  const res = await fetch(`${viewer.url}/api/events`, { headers: { "x-windtunnel-token": viewer.token }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const seen: any[] = [];
  return {
    async until(match: (e: any) => boolean, ms = 15_000): Promise<any> {
      const deadline = Date.now() + ms;
      for (;;) {
        const found = seen.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no matching event; saw ${JSON.stringify(seen).slice(0, 2000)}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended");
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop()!;
        for (const p of parts) {
          const data = p.split("\n").find((l) => l.startsWith("data: "));
          if (data) seen.push(JSON.parse(data.slice(6)));
        }
      }
    },
    close: () => controller.abort(),
  };
}

/** A finished run (repetition 1 broke a rule after a double click, 2 held) and one still going. */
async function writeStore(dir: string): Promise<void> {
  const write = async (path: string, data: unknown) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), typeof data === "string" ? data : JSON.stringify(data));
  };
  const experiment = { id: "send-twice", description: "Alice double-clicks Send.", flow: "send", params: {}, perturb: [{ do: "double-click", step: "send" }], rules: "all", repeat: 2, timeout: 60_000 };
  const startedAt = "2026-10-29T10:00:00.000Z";
  const steps = (twice: boolean) => [
    { tab: "alice", step: "open", start: 5, end: 55, actions: [], quiet: true },
    { tab: "alice", step: "send", start: 58, end: 130, actions: [], quiet: true, ...(twice ? { harness: ["double-clicked"] } : {}) },
  ];
  const requests = (twice: boolean) => [
    { id: 1, tab: "alice", step: "open", method: "GET", url: "/", type: "document", start: 10, end: 50, status: 200 },
    { id: 2, tab: "alice", step: "send", method: "POST", url: "/api/send", type: "fetch", start: 60, sent: 60, response: 120, end: 121, status: 200, ...(twice ? { harness: ["double-clicked"] } : {}) },
    ...(twice ? [{ id: 3, tab: "alice", step: "send", method: "POST", url: "/api/send", type: "fetch", start: 62, sent: 62, response: 125, end: 126, status: 200 }] : []),
  ];
  const insert = (at: number, conn: number) => ({ at, ms: 1, conn, sql: "INSERT INTO hits (who) VALUES ($1) RETURNING id", params: ["alice"], tag: "INSERT 0 1" });
  const reps = [
    { rep: 1, variant: "default", outcome: "broken", broken: ["at-most-one-hit"], durationMs: 900, diff: "hits +2" },
    { rep: 2, variant: "default", outcome: "ok", broken: [], durationMs: 800, diff: "hits +1" },
  ];
  for (const r of reps) {
    const twice = r.rep === 1;
    await write(`${RUN}/reps/${r.rep}/result.json`, {
      ...r,
      startedAt,
      rules: [{ id: "at-most-one-hit", ok: !twice, rows: twice ? [{ hits: 2 }] : [] }],
      errors: [],
      steps: steps(twice),
      webhooks: [],
      charges: [],
      console: [],
      traces: [],
    });
    await write(`${RUN}/reps/${r.rep}/requests.json`, requests(twice));
    await write(`${RUN}/reps/${r.rep}/sql.json`, { dropped: 0, statements: twice ? [insert(70, 1), insert(72, 2)] : [insert(70, 1)] });
    await write(`${RUN}/reps/${r.rep}/db-diff.json`, {
      tables: { hits: { added: twice ? [{ id: 1, who: "alice" }, { id: 2, who: "alice" }] : [{ id: 1, who: "alice" }], removed: [], changed: [] } },
      summary: r.diff,
    });
  }
  await write(`${RUN}/experiment.json`, experiment);
  await write(`${RUN}/run.json`, {
    runId: RUN,
    experiment: experiment.id,
    version: { id: "abc123", label: "working tree" },
    outcome: "flaky",
    variants: [{ variant: "default", runs: 2, ok: 1, broken: 1, errors: 0, outcome: "flaky", flakeRate: 0.5, rules: { "at-most-one-hit": 1 } }],
    reps,
    startedAt,
    durationMs: 1000,
    dir: join(dir, RUN),
  });
  await write("index.jsonl", `${JSON.stringify({ id: RUN, experiment: experiment.id, version: "abc123", startedAt, outcome: "flaky", headline: "flaky · at-most-one-hit 1/2" })}\n`);
  await write(`${OPEN}/experiment.json`, experiment);
  await mkdir(join(dir, OPEN, "reps", "1"), { recursive: true });
  await write(`${OPEN}/reps/2/result.json`, { ...reps[1], rep: 2, rules: [], errors: [], steps: [], webhooks: [], charges: [], console: [], traces: [] });
}

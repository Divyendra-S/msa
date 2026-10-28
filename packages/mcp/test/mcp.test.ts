// The MCP server end to end: the real CLI over stdio against the tiny fixture app.
// Needs the development Postgres (`pnpm db:up`).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFixtureRepo, pgAvailable } from "../../core/test/fixture.ts";

const CLI = join(import.meta.dirname, "..", "..", "cli", "src", "bin.ts");

// Only for the map and the request → handler lookup; the app itself is server.cjs.
const ROUTE = `export async function POST(req: Request) {
  const user = await getSessionUser(req);
  await db.query("INSERT INTO hits (who) VALUES ($1) RETURNING id", [user]);
  await fetch(process.env.PAYMENT_API_URL + "/v1/charges", { method: "POST" });
  return Response.json({ ok: true });
}
async function getSessionUser(req: Request) { return req.headers.get("cookie"); }
const db = { query: async (..._args: unknown[]) => ({ rows: [] }) };
`;

describe("mcp server", { skip: !(await pgAvailable()) && "Postgres not reachable (pnpm db:up)" }, () => {
  let repo: string;
  let cache: string;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    return { text: result.content.map((c) => c.text).join("\n"), isError: !!result.isError };
  };

  before(async () => {
    repo = await createFixtureRepo(
      { plain: "flow: send", "double-submit": "flow: send\nperturb: [{ do: double-submit, step: send }]" },
      { "app/api/send/route.ts": ROUTE },
    );
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "mcp"],
      cwd: repo,
      env: { ...(process.env as Record<string, string>), WINDTUNNEL_CACHE_DIR: cache },
      stderr: "ignore",
    });
    client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    await rm(repo, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("offers six tools with short descriptions", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "windtunnel_branch",
      "windtunnel_evidence",
      "windtunnel_map",
      "windtunnel_prove",
      "windtunnel_run",
      "windtunnel_validate",
    ]);
    for (const t of tools) assert.ok((t.description ?? "").length <= 360, `${t.name}: ${t.description?.length} chars`);
  });

  it("validates files and checks rules against the seed data", async () => {
    const { text, isError } = await call("windtunnel_validate");
    assert.equal(isError, false, text);
    assert.equal(text, "ok: 2 experiment(s), 2 rule(s) hold on the seed data");
  });

  it("maps routes from the code", async () => {
    const { text } = await call("windtunnel_map");
    assert.match(text, /POST \/api\/send {2}app\/api\/send\/route\.ts/);
    assert.match(text, /INSERT hits/);
    assert.match(text, /hits\(id PK, who text\) 0 rows/);
  });

  it("runs an experiment and returns evidence with the handler file", async () => {
    const run = await call("windtunnel_run", { experiments: ["double-submit"], repeat: 1 });
    assert.equal(run.isError, false, run.text);
    assert.match(run.text, /double-submit\s+FAIL\s+1 broken\s+at-most-one-hit 1\/1/);
    const id = /Evidence: windtunnel_evidence handle=<run> \(e\.g\. (\S+)\)/.exec(run.text)?.[1];
    assert.ok(id, run.text);

    const evidence = await call("windtunnel_evidence", { handle: id });
    assert.match(evidence.text, /Rule at-most-one-hit broken/);
    assert.match(evidence.text, /Handlers: .*POST \/api\/send → app\/api\/send\/route\.ts/);
    const diff = await call("windtunnel_evidence", { handle: `${id}/1/diff:hits` });
    assert.match(diff.text, /hits: \+\{id: 1, who: alice@example\.test\} \+\{id: 2, who: alice@example\.test\}/);

    const missing = await call("windtunnel_evidence", { handle: "999999-999999-zzzz" });
    assert.equal(missing.isError, true);
  });

  it("starts, lists and stops a branch by hand", async () => {
    const started = await call("windtunnel_branch", { action: "start" });
    const url = /app\s+(http\S+)/.exec(started.text)?.[1];
    assert.ok(url, started.text);
    assert.equal((await fetch(`${url}/login`)).status, 200);
    assert.match((await call("windtunnel_branch", { action: "list" })).text, new RegExp(url.replace(/[.:/]/g, "\\$&")));
    assert.equal((await call("windtunnel_branch", { action: "stop" })).text, "stopped 1 branch(es)");
    await assert.rejects(fetch(`${url}/login`));
  });

  it("refuses to prove a fix that changes nothing", async () => {
    const { text, isError } = await call("windtunnel_prove", { experiments: ["double-submit"] });
    assert.equal(isError, true);
    assert.match(text, /same code as the base/);
  });
});

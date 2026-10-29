// What the Mac app uses besides the web viewer's API: the experiments with their newest run,
// runs started through the CLI, and hunts in Claude Code billed to an Anthropic API key only.
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFixtureRepo } from "../../core/test/fixture.ts";
import { startViewer, type Viewer } from "../src/server.ts";

const FAKE_CLI = join(import.meta.dirname, "fake-cli.mjs");
const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.mjs");
const RUN = "261029-100000-aaaa";

describe("viewer bridge for the Mac app", () => {
  let repo: string;
  let viewer: Viewer;
  let log: string;
  let env: NodeJS.ProcessEnv;
  const call = (path: string, init: RequestInit = {}, v = () => viewer) =>
    fetch(`${v().url}${path}`, {
      ...init,
      headers: { "x-windtunnel-token": v().token, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
  const json = async <T = any>(path: string): Promise<T> => {
    const res = await call(path);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    return (await res.json()) as T;
  };
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  before(async () => {
    repo = await createFixtureRepo({
      "send-twice": "description: Alice double-clicks Send.\nflow: send\nperturb: [{ do: double-submit, step: send }]",
      plain: "flow: send",
    });
    const bin = join(repo, "fake-bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
    await chmod(join(bin, "claude"), 0o755);
    log = join(repo, "claude-call.json");
    const runs = join(repo, ".windtunnel", "runs");
    await mkdir(runs, { recursive: true });
    await writeFile(
      join(runs, "index.jsonl"),
      `${JSON.stringify({ id: RUN, experiment: "send-twice", version: "abc123", startedAt: "2026-10-29T10:00:00.000Z", outcome: "fail", headline: "fail · at-most-one-hit 1/1" })}\n`,
    );
    env = {
      PATH: [bin, ...(process.env.PATH ?? "").split(delimiter)].join(delimiter),
      HOME: process.env.HOME,
      WT_FAKE_LOG: log,
      ANTHROPIC_API_KEY: "sk-ant-test",
      // A shell set up for Muse (scripts/muse-env.sh --claude): none of this may reach Claude Code.
      ANTHROPIC_BASE_URL: "https://api.meta.ai",
      ANTHROPIC_AUTH_TOKEN: "meta-key",
      MODEL_API_KEY: "meta-key",
      META_API_KEY: "meta-key",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CONFIG_DIR: "/the/users/own/claude",
      CLAUDECODE: "1",
      OPENAI_API_KEY: "openai",
    };
    viewer = await startViewer({ cwd: repo, port: 0, env, distDir: join(repo, "no-ui"), cli: [process.execPath, FAKE_CLI], pluginDir: "/plugin/dir" });
  });

  after(async () => {
    await viewer?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
  });

  it("lists experiments with their newest run", async () => {
    const list = await json("/api/experiments");
    assert.deepEqual(list.map((e: { id: string }) => e.id), ["plain", "send-twice"]);
    const [plain, twice] = list;
    assert.deepEqual(
      { ...twice, file: undefined },
      {
        id: "send-twice",
        description: "Alice double-clicks Send.",
        flow: "send",
        repeat: 1,
        file: undefined,
        perturb: 1,
        last: { run: RUN, outcome: "fail", headline: "fail · at-most-one-hit 1/1", startedAt: "2026-10-29T10:00:00.000Z" },
      },
    );
    assert.equal(twice.file, join(repo, ".windtunnel", "experiments", "send-twice.yaml"));
    assert.equal(plain.last, undefined);
    assert.equal(plain.perturb, undefined);
  });

  it("starts runs through the CLI, one at a time, with no agent's keys", async () => {
    const events = await openEvents(viewer);
    const res = await post("/api/experiments/run", { experiments: ["send-twice"], repeat: 2 });
    assert.equal(res.status, 200);
    const job = (await res.json()) as { id: string; status: string; experiments: string[]; repeat: number };
    assert.deepEqual([job.status, job.experiments, job.repeat], ["running", ["send-twice"], 2]);
    const done = await events.until((e) => e.type === "job" && e.id === job.id && e.info.status !== "running");
    const line = await events.until((e) => e.type === "job-output" && e.id === job.id && e.line.startsWith("args "));
    events.close();
    assert.equal(line.line, `args run send-twice --repeat 2 --cwd ${repo}`);
    // Exit 1 with no error: the run finished and an experiment failed.
    assert.deepEqual([done.info.status, done.info.exitCode, done.info.error], ["done", 1, undefined]);
    assert.deepEqual(done.info.output, [line.line, "env clean", "send-twice  fail  at-most-one-hit 1/1"]);
    assert.equal((await json("/api/jobs"))[0].id, job.id);

    const broken = (await (await post("/api/experiments/run", { experiments: ["broken"] })).json()) as { id: string };
    const failed = await waitFor(async () => (await json("/api/jobs")).find((j: { id: string; status: string }) => j.id === broken.id && j.status !== "running"));
    assert.deepEqual([failed.status, failed.error], ["failed", "unknown experiment(s): broken"]);

    const slow = (await (await post("/api/experiments/run", { experiments: ["slow"] })).json()) as { id: string };
    assert.equal((await json("/api/status")).jobs.running.id, slow.id);
    assert.equal((await post("/api/experiments/run", {})).status, 409);
    assert.deepEqual(await (await post(`/api/jobs/${slow.id}/stop`, {})).json(), { stopping: true });
    const stopped = await waitFor(async () => (await json("/api/jobs")).find((j: { id: string; status: string; endedAt?: string }) => j.id === slow.id && j.endedAt));
    assert.equal(stopped.status, "stopped");
    assert.equal((await json("/api/status")).jobs.running, null);

    assert.equal((await post("/api/experiments/run", { experiments: ["--patch=x"] })).status, 400);
    assert.equal((await post("/api/experiments/run", { repeat: 0 })).status, 400);
  });

  it("hunts in Claude Code on the API key only, never the user's login or a Muse shell's settings", async () => {
    const status = await json("/api/status");
    assert.deepEqual(status.hunt.hosts.claude, {
      ok: true,
      command: ["claude", "-p", "--bare", "--output-format", "stream-json", "--verbose", "--plugin-dir", "{plugin_dir}", "--model", "{model}", "--max-budget-usd", "{budget}", "--permission-mode", "acceptEdits", "--allowedTools", "mcp__plugin_windtunnel_windtunnel,Read,Grep,Glob,Edit,Write"],
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      defaultModel: "claude-opus-5-5",
    });
    // Muse Code isn't installed here: the web viewer's fields still say so.
    assert.equal(status.hunt.ok, false);
    assert.equal(status.hunt.hosts.muse.ok, false);

    const events = await openEvents(viewer);
    const res = await post("/api/hunts", { prompt: "/windtunnel:hunt checkout", host: "claude", model: "claude-sonnet-5-5", budgetUsd: 2 });
    assert.equal(res.status, 200, await res.clone().text());
    const info = (await res.json()) as { id: string; host: string; model: string; budgetUsd: number; command: string[] };
    assert.deepEqual([info.host, info.model, info.budgetUsd], ["claude", "claude-sonnet-5-5", 2]);
    assert.ok(!info.command.includes("/windtunnel:hunt checkout"));
    const done = await events.until((e) => e.type === "hunt" && e.id === info.id && e.info.status !== "running");
    events.close();
    assert.equal(done.info.status, "done");
    // The result event's totals replace the per-message counts (Claude Code repeats them).
    assert.deepEqual(done.info.usage, { input: 1000, output: 60, cached: 4000, usd: 0.42 });

    const call = JSON.parse(await readFile(log, "utf8")) as { argv: string[]; env: Record<string, string> };
    assert.deepEqual(call.argv.slice(0, 3), ["-p", "/windtunnel:hunt checkout", "--bare"]);
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--plugin-dir"), call.argv.indexOf("--plugin-dir") + 6), ["--plugin-dir", "/plugin/dir", "--model", "claude-sonnet-5-5", "--max-budget-usd", "2"]);
    assert.equal(call.env.ANTHROPIC_API_KEY, "sk-ant-test");
    assert.equal(call.env.CLAUDE_CONFIG_DIR, join(repo, ".windtunnel", "cache", "claude-headless"));
    assert.equal(call.env.WINDTUNNEL_JOB, `hunt-${info.id}`);
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "MODEL_API_KEY", "META_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDECODE", "OPENAI_API_KEY"]) {
      assert.equal(call.env[k], undefined, `${k} reached Claude Code`);
    }

    const { events: log2 } = await json(`/api/hunts/${info.id}`);
    assert.deepEqual(
      log2.map((e: { kind: string; tool?: string }) => (e.kind === "tool" ? `tool ${e.tool}` : e.kind)),
      ["event", "message", "tool mcp__plugin_windtunnel_windtunnel__windtunnel_map", "event", "message", "end"],
    );

    assert.equal((await post("/api/hunts", { prompt: "x", host: "codex" })).status, 400);
    assert.equal((await post("/api/hunts", { prompt: "x", host: "claude", model: "gpt-5" })).status, 400);
    assert.equal((await post("/api/hunts", { prompt: "x", host: "claude", budgetUsd: 500 })).status, 400);
    assert.equal((await post("/api/hunts", { prompt: "--dangerously-skip-permissions", host: "claude" })).status, 400);
  });

  it("keeps Claude Code off without an API key", async () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = env;
    const other = await startViewer({ cwd: repo, port: 0, env: rest, distDir: join(repo, "no-ui"), pluginDir: "/plugin/dir" });
    try {
      const status = (await (await call("/api/status", {}, () => other)).json()) as any;
      assert.equal(status.hunt.hosts.claude.ok, false);
      assert.match(status.hunt.hosts.claude.reason, /Anthropic API key.*never use your Claude login/);
      const refused = await call("/api/hunts", { method: "POST", body: JSON.stringify({ prompt: "x", host: "claude" }) }, () => other);
      assert.equal(refused.status, 412);
      // Started without the CLI's command: no runs from here.
      assert.equal((await call("/api/experiments/run", { method: "POST", body: "{}" }, () => other)).status, 501);
    } finally {
      await other.close();
    }
  });
});

async function waitFor<T>(check: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

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

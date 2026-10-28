// Failure sorting, selector repair and the crawl on the tiny fixture app (needs Postgres).
// Its Send button is renamed Submit, so the `send` flow is out of date; a 503 on the send
// request is a failure only under that perturbation.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clean, type ExperimentResult, loadExperiments, Runner } from "@windtunnel/core";
import { createFixtureRepo, pgAvailable, SEND_FLOW, SERVER } from "../../core/test/fixture.ts";
import { crawl, crawlDrillDown, formatCrawl } from "../src/crawl.ts";
import { Decider, DecisionStore, type LevelOne } from "../src/decider.ts";
import { answerDecision, formatTriage, sortFailures } from "../src/triage.ts";

const APP = SERVER.replace('<button id="send">Send</button>', '<a href="/missing">Help</a><button id="send">Submit</button>');

describe("failure sorting and crawl", { skip: !(await pgAvailable()) && "Postgres not reachable (pnpm db:up)" }, () => {
  let repo: string;
  let cache: string;
  let runner: Runner;
  let results: ExperimentResult[];

  before(async () => {
    repo = await createFixtureRepo(
      {
        renamed: "flow: send",
        "fails-503": `flow: send-by-id\nperturb:\n  - { do: fail, request: "POST /api/send", status: 503 }`,
      },
      {
        "server.cjs": APP,
        ".windtunnel/flows/send-by-id.ts": SEND_FLOW.replace('page.getByRole("button", { name: "Send" })', 'page.locator("#send")'),
      },
    );
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    process.env.WINDTUNNEL_CACHE_DIR = cache;
    runner = await Runner.open(repo);
    results = await runner.run(await loadExperiments(runner.project));
  });

  after(async () => {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("heals a renamed button in the flow file, checks it, re-runs; asks about a failure only the perturbation causes", async () => {
    assert.deepEqual(results.map((r) => r.outcome), ["error", "error"]);
    const asked: string[] = [];
    // A Level 1 stand-in: sure that a 503 leaving the user stuck is a bug.
    const levelOne: LevelOne = {
      name: "spark",
      async ask(q) {
        asked.push(q.kind);
        return { choice: "bug", confidence: 0.9, inputTokens: 300, outputTokens: 10, usd: 0.0004 };
      },
    };
    const decisions = new DecisionStore(runner.project.stateDir);
    const experiments = await loadExperiments(runner.project);
    const entries = await sortFailures(runner, results, experiments, { decider: new Decider({ levelOne }), decisions });
    const renamed = entries.find((e) => e.experiment === "renamed")!;
    assert.equal(renamed.label, "outdated-test");
    assert.equal(renamed.by, "rules");
    assert.deepEqual(renamed.healed?.map((h) => [h.file, h.to]), [[".windtunnel/flows/send.ts", 'getByRole("button", { name: "Submit" })']]);
    assert.equal(renamed.rerun?.outcome, "pass");
    assert.match(await readFile(join(repo, ".windtunnel/flows/send.ts"), "utf8"), /getByRole\("button", \{ name: "Submit" \}\)/);

    const failed = entries.find((e) => e.experiment === "fails-503")!;
    assert.equal(failed.label, "bug");
    assert.equal(failed.by, "spark");
    assert.deepEqual(asked, ["triage"]);
    const saved = JSON.parse(await readFile(join(results[0]!.dir, "triage.json"), "utf8"));
    assert.equal(saved.label, results[0]!.experiment === "renamed" ? "outdated-test" : "bug");
    const text = formatTriage(entries, "rules, then Muse Spark, then you");
    assert.match(text, /^Failure sorting \(decided by rules, then Muse Spark, then you\):/);
    assert.match(text, /renamed\s+outdated test .*\[by rules\]/);
    assert.match(text, /fails-503\s+bug .*\[by Muse Spark\]/);
    assert.match(text, /healed \.windtunnel\/flows\/send\.ts:\d+ {2}getByRole\('button', \{ name: 'Send' \}\) → getByRole\("button", \{ name: "Submit" \}\)/);
    assert.match(text, /re-ran the whole experiment: PASS 1\/1 runs ok \(run [\w-]+; first run [\w-]+\)/);
  });

  it("without a Level 1 model the question waits for the agent, who answers it", async () => {
    const failed = results.find((r) => r.experiment === "fails-503")!;
    const decisions = new DecisionStore(runner.project.stateDir);
    const [entry] = await sortFailures(runner, [failed], await loadExperiments(runner.project), { decider: new Decider({}), decisions });
    assert.equal(entry!.label, undefined);
    assert.equal(entry!.by, "agent");
    assert.deepEqual(Object.keys(entry!.decision!.question.options), ["bug", "outdated-test"]);
    assert.match(formatTriage([entry!], "rules, then you"), new RegExp(`answer with windtunnel_decide id=${entry!.decision!.id}`));
    const result = await answerDecision(runner, decisions, entry!.decision!.id, "outdated-test", []);
    assert.match(result, /marked outdated test/);
    assert.equal(JSON.parse(await readFile(join(failed.dir, "triage.json"), "utf8")).label, "outdated-test");
    assert.deepEqual(await decisions.open(), []);
  });

  it("crawls as a visitor and a test user and sweeps for problems, with no model", async () => {
    const result = await crawl(runner, { users: ["alice"] });
    assert.deepEqual(result.as, ["anonymous", "alice"]);
    const home = result.pages.find((p) => p.url === "/" && p.as === "alice")!;
    assert.ok(home.snapshot.elements.some((e) => e.role === "button" && e.name === "Submit"));
    assert.ok(result.sweep.some((f) => f.kind === "link" && /\/missing answers 404/.test(f.summary)), JSON.stringify(result.sweep));
    // The fixture's pages have no <title> and no lang: axe reports both.
    assert.ok(result.sweep.some((f) => f.kind === "a11y" && /html-has-lang|document-title/.test(f.summary)));
    assert.match(formatCrawl(result), /\/ \(alice, 200\) {2}button "Submit"/);
    assert.match(crawlDrillDown(result, "crawl:/"), /page\.getByRole\("button", \{ name: "Submit" \}\)/);
  });
});

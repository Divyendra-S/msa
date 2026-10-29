import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderBoard } from "../src/board.ts";
import { loadCases, type ZooCase } from "../src/cases.ts";
import { refusedHost } from "../src/hosts.ts";
import { type FindingScore, isTestFile, judge, namesFile, parseReport, type TrialScore } from "../src/score.ts";

const bug: ZooCase = {
  id: "09-another-users-order",
  title: "Another user's order (IDOR)",
  summary: "",
  control: false,
  experiment: "order-read-by-another-user",
  breaks: ["orders-shown-only-to-their-buyer"],
  handler: "app/api/orders/[id]/route.ts",
  patchFile: "",
  patch: "",
};
const control: ZooCase = { ...bug, id: "c3-owner-checked-in-code", control: true, experiment: undefined, handler: undefined, breaks: [] };

const finding = (over: Partial<FindingScore>): FindingScore => ({ title: "x", files: [], verdict: "no command", namesHandler: false, ...over });

describe("bench scoring", () => {
  test("reads the agent's report, tolerating loose shapes", () => {
    const findings = parseReport(
      JSON.stringify({ findings: [{ title: "IDOR", files: "app/api/orders/[id]/route.ts", reproduce: "  node r.mjs ", fixed: true }, { summary: "no title" }] }),
    );
    assert.deepEqual(findings[0], { title: "IDOR", files: ["app/api/orders/[id]/route.ts"], reproduce: "node r.mjs", fixed: true });
    assert.equal(findings[1]!.title, "finding 2");
    assert.throws(() => parseReport("{}"), /no findings list/);
  });

  test("sorts changed files into the fix and the tests", () => {
    assert.equal(isTestFile("app/api/orders/route.ts", "M"), false);
    assert.equal(isTestFile("lib/orders.ts", "A"), false);
    assert.equal(isTestFile(".windtunnel/experiments/x.yaml", "A"), true);
    assert.equal(isTestFile("windtunnel.config.yaml", "M"), true);
    assert.equal(isTestFile("e2e/checkout.spec.ts", "A"), true);
    assert.equal(isTestFile("repro/idor.mjs", "A"), true);
    assert.equal(isTestFile("scripts/local.mjs", "M"), false);
    assert.equal(isTestFile("bench-report.json", "A"), true);
  });

  test("matches the bug's file with or without ./ and line numbers", () => {
    assert.equal(namesFile({ title: "", files: ["./app/api/orders/[id]/route.ts:12"] }, bug.handler), true);
    assert.equal(namesFile({ title: "", files: ["app/api/orders/route.ts"] }, bug.handler), false);
  });

  test("found needs a reproduction that fails with the bug and passes without it", () => {
    const match = finding({ verdict: "match", namesHandler: true, onBug: { failed: 3, runs: 3, timedOut: 0 }, onClean: { failed: 0, runs: 3, timedOut: 0 } });
    assert.deepEqual(judge(bug, [match, finding({ verdict: "not reproduced" })]), { found: "yes", reproduced: "3/3", handler: true, falseAlarms: 1 });
    // Fails on the clean shop too: another bug, not this one, and not a false alarm.
    assert.deepEqual(judge(bug, [finding({ verdict: "also on clean" })]), { found: "no", handler: false, falseAlarms: 0 });
    // The right file but no way to show it.
    assert.deepEqual(judge(bug, [finding({ namesHandler: true })]), { found: "claimed", handler: true, falseAlarms: 0 });
    assert.deepEqual(judge(control, [finding({ verdict: "control" }), finding({ verdict: "control" })]), { found: "n/a", handler: false, falseAlarms: 2 });
  });

  test("loads the zoo: ten bugs, then three controls", async () => {
    const cases = await loadCases();
    assert.equal(cases.filter((c) => !c.control).length, 10);
    assert.deepEqual(cases.filter((c) => c.control).map((c) => c.id), ["c1-stock-row-lock", "c2-webhook-unique-charge", "c3-owner-checked-in-code"]);
    for (const c of cases.filter((c) => !c.control)) assert.ok(c.experiment && c.handler && c.breaks.length, c.id);
    assert.deepEqual((await loadCases(["05", "c2"])).map((c) => c.id), ["05-oversell", "c2-webhook-unique-charge"]);
    await assert.rejects(loadCases(["99"]), /unknown case/);
  });

  test("never runs an agent that uses its own user's login", () => {
    assert.match(refusedHost(["claude", "-p", "x"])!, /own login/);
    assert.match(refusedHost(["/opt/homebrew/bin/codex", "exec"])!, /own login/);
    assert.equal(refusedHost(["muse", "exec"]), undefined);
  });

  test("renders totals per setup and a row per trial", () => {
    const base: TrialScore = {
      trial: "09-another-users-order-B",
      trialId: "t0001",
      batch: "t",
      case: bug.id,
      title: bug.title,
      setup: "B",
      control: false,
      host: "muse",
      model: "muse-wonder-1.0",
      found: "yes",
      reproduced: "3/3",
      handler: true,
      fixed: { ok: 5, runs: 5, outcome: "pass", run: "r" },
      regressions: [],
      falseAlarms: 0,
      findings: [],
      changed: { fix: [], tests: [] },
      usage: { input: 90_000, output: 10_000, cached: 0, hostUsd: 0.56, level1Usd: 0, usd: 0.56, toolOutputTokens: 4_000, estimated: true },
      wallMs: 6 * 60_000,
      notes: [],
      scoredAt: "",
    };
    const board = renderBoard([base, { ...base, trial: "c3-B", case: control.id, control: true, found: "n/a", falseAlarms: 1, fixed: undefined }], "t");
    assert.match(board, /\| B: Wind Tunnel, rules only \| 1\/1 \| 1\/1 \| 1\/1 \| 0 \| 1 \/ 0 \| 200k \| ~\$1\.12 \| 12 min \| 200k \|/);
    assert.match(board, /\| 09-another-users-order \| B \| ✓ \| 3\/3 \| ✓ \| ✓ 5\/5 \|/);
  });
});

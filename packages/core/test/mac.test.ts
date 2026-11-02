// Swift Mac apps: probe points as calls at the seam, XCTest scenarios, ThreadSanitizer's reports,
// and what Wind Tunnel reads from the Swift code.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseConfig } from "../src/config.ts";
import { parseSanitizerLog, readSanitizerReports } from "../src/mac/sanitizer.ts";
import { ScenarioRun } from "../src/mac/scenario.ts";
import { findScenario, probePoints } from "../src/mac/swift.ts";
import type { Project } from "../src/project.ts";
import { checkRules, parseRules } from "../src/rules.ts";
import { checkExperiment, parseExperiment, variantsOf } from "../src/runner/experiment.ts";
import { matchesLogged, matchesRequest, parseRequestPattern } from "../src/runner/match.ts";
import { callName } from "../src/runner/network.ts";

const parse = (text: string) => parseExperiment(text, "test.yaml", "test");

describe("probe points in experiments", () => {
  it("names a point with point, * matching any part of the name", () => {
    const write = parseRequestPattern("point writer.write");
    assert.ok(matchesRequest(write, "POINT", "http://probe/__windtunnel/point/writer.write"));
    assert.ok(!matchesRequest(write, "POST", "http://probe/__windtunnel/point/writer.write"));
    assert.ok(matchesLogged(parseRequestPattern("point writer.*"), "POINT", "writer.finish"));
    assert.ok(!matchesLogged(write, "POINT", "writer.finish"));
    assert.ok(matchesLogged(parseRequestPattern("invoke save_note"), "INVOKE", "save_note"));
    assert.ok(matchesLogged(parseRequestPattern("POST /api/orders"), "POST", "/api/orders?x=1"));
    assert.deepEqual(callName("POINT", new URL("http://probe/__windtunnel/point/writer.write")), { method: "POINT", url: "writer.write" });
  });

  it("reads `point:` as short for `request: point …`, and cancel as a point pressure", () => {
    const e = parse(`scenario: RecorderScenarios/testRecordAndStop
perturb:
  - { do: delay, point: frame.compress, ms: 300 }
  - { do: cancel, point: writer.finish }
race: { point: export.encode, order: each }`);
    assert.deepEqual(e.perturb, [
      { do: "delay", request: "point frame.compress", ms: 300, count: 1 },
      { do: "cancel", request: "point writer.finish", count: 1 },
    ]);
    assert.equal(e.race?.request, "point export.encode");
    assert.equal(e.flow, undefined);
    assert.deepEqual(variantsOf(e, ["app"]).map((v) => v.name), ["together", "1,2", "2,1"]);
  });

  it("has a flow or a scenario, not both", () => {
    assert.throws(() => parse("description: nothing to run"), /a flow, or \(for a Swift Mac app\) a scenario/);
    assert.throws(() => parse("flow: f\nscenario: A/testB"), /a flow, or/);
    assert.throws(() => parse("scenario: testOnly"), /Class\/testMethod/);
  });
});

describe("a Mac app's config", () => {
  it("defaults to a Swift package here, built with ThreadSanitizer, its home folder the run's own", () => {
    const config = parseConfig("app:\n  kind: mac\n");
    assert.deepEqual(config.mac, { dir: ".", sanitizer: "thread", env: {} });
    assert.equal(config.app.isolateHome, true);
    assert.equal(config.app.start, undefined);
  });

  it("has no server, and other apps still need one", () => {
    assert.throws(() => parseConfig("app:\n  kind: mac\n  start: ./server\n"), /no server to start/);
    assert.throws(() => parseConfig("app:\n  kind: web\n"), /app.start/);
    assert.throws(() => parseConfig("app:\n  kind: web\n  start: x\nmac: {}\n"), /`mac:` is for app.kind mac/);
  });
});

const SCENARIOS = `import Recorder
import WindTunnelProbe
import XCTest

final class RecorderScenarios: XCTestCase {
    // A brace in a comment: {
    func testRecordAndStop() async throws {
        try await Probe.step("start") { try await recorder.start(take: "a {b}") }
        try await Probe.step("stop") { try await recorder.stop() }
    }

    func testTwoExports() async throws {
        try await Probe.step("export") {}
    }
}
`;

const WRITER = `import WindTunnelProbe

actor TakeWriter {
    func append() async throws {
        try await Probe.point("frame.compress")
        // try await Probe.point("commented.out")
    }

    func stop() async throws {
        try await Probe.point("writer.finish") {
            try await finish()
        }
    }
}
`;

describe("reading a Swift package", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-swift-"));
    await mkdir(join(root, "Tests", "RecorderScenarios"), { recursive: true });
    await mkdir(join(root, "Sources", "Recorder"), { recursive: true });
    await mkdir(join(root, ".build", "checkouts"), { recursive: true });
    await writeFile(join(root, "Tests", "RecorderScenarios", "RecorderScenarios.swift"), SCENARIOS);
    await writeFile(join(root, "Sources", "Recorder", "TakeWriter.swift"), WRITER);
    await writeFile(join(root, ".build", "checkouts", "Other.swift"), WRITER.replace("frame.compress", "built.copy"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a scenario's test in its test target, and the steps it marks", async () => {
    const scenario = await findScenario(root, "RecorderScenarios/testRecordAndStop");
    assert.deepEqual(scenario, {
      test: "RecorderScenarios.RecorderScenarios/testRecordAndStop",
      file: "Tests/RecorderScenarios/RecorderScenarios.swift",
      line: 7,
      steps: ["start", "stop"],
    });
    assert.deepEqual((await findScenario(root, "RecorderScenarios.RecorderScenarios/testTwoExports"))?.steps, ["export"]);
    assert.equal(await findScenario(root, "RecorderScenarios/testMissing"), undefined);
    assert.equal(await findScenario(root, "Other.RecorderScenarios/testRecordAndStop"), undefined);
  });

  it("lists the probe points in the code, and which cover a section", async () => {
    assert.deepEqual(await probePoints(root), [
      { name: "frame.compress", file: "Sources/Recorder/TakeWriter.swift", line: 5, section: false },
      { name: "writer.finish", file: "Sources/Recorder/TakeWriter.swift", line: 10, section: true },
    ]);
  });

  it("checks a Mac app's experiments: scenario, steps, point pressures only", async () => {
    const project = { root, stateDir: join(root, ".windtunnel"), config: { app: { kind: "mac" }, mac: { dir: "." }, users: {} } } as unknown as Project;
    const check = (yaml: string) => checkExperiment(parse(yaml), project, []);
    assert.deepEqual(await check("scenario: RecorderScenarios/testRecordAndStop\nperturb: [{ do: cancel, point: writer.finish, step: stop }]"), { errors: [], warnings: ["no rules in .windtunnel/rules.yaml: runs only check that the flow finishes"] });
    const { errors, warnings } = await check(`scenario: RecorderScenarios/testRecordAndStop
users: [alice]
perturb:
  - { do: delay, point: frame.compres, ms: 10, step: record }
  - { do: lose-response, point: writer.finish }
  - { do: delay, request: POST /api/x, ms: 1 }
  - { do: kill-app, step: stop }`);
    assert.deepEqual(errors, [
      "unknown user \"alice\" (config users: none)",
      "lose-response: not for Mac apps (their pressures are delay, fail and cancel at a probe point)",
      "delay POST /api/x: a Mac app's calls are probe points (point: <name>)",
      "kill-app: not for Mac apps (their pressures are delay, fail and cancel at a probe point)",
      "users: a Mac app's scenario is its own client; it has no users",
      "step \"record\" is not in scenario RecorderScenarios/testRecordAndStop (steps: start, stop)",
    ]);
    assert.ok(warnings.includes("point frame.compres: no Probe.point in the code has that name (points: frame.compress, writer.finish)"));
    assert.deepEqual((await check("scenario: RecorderScenarios/testNope")).errors, [`scenario RecorderScenarios/testNope: no such XCTest method in ${root}/Tests (Class/testMethod)`]);
    assert.deepEqual((await check("flow: checkout")).errors, ["flow: a Swift Mac app's experiments run a scenario (scenario: Class/testMethod), not a flow"]);

    const web = { ...project, config: { app: { kind: "web" }, users: {} } } as unknown as Project;
    assert.deepEqual((await checkExperiment(parse("scenario: A/testB"), web, [])).errors, ["scenario: only Swift Mac apps (app.kind: mac) run XCTest scenarios; this app's experiments have a flow"]);
  });
});

// As ThreadSanitizer prints it on macOS.
const REPORT = `==================
WARNING: ThreadSanitizer: data race (pid=4242)
  Write of size 8 at 0x000108f04a30 by thread T1:
    #0 FrameStats.didCapture() Frame.swift:34 (RecorderPackageTests:arm64+0x1a2b4)
    #1 closure #1 in FrameSource.frames(count:every:) Frame.swift:66 (RecorderPackageTests:arm64+0x1b0c8)
    #2 _dispatch_call_block_and_release <null> (libdispatch.dylib:arm64e+0x1a54)

  Previous read of size 8 at 0x000108f04a30 by thread T2 (mutexes: write M0):
    #0 FrameStats.backlog.getter Frame.swift:46 (RecorderPackageTests:arm64+0x1a6f0)
    #1 Recorder.append(_:) Recorder.swift:30 (RecorderPackageTests:arm64+0x1c2e4)

  Location is heap block of size 48 at 0x000108f04a10 allocated by main thread:
    #0 malloc <null> (libclang_rt.tsan_osx_dynamic.dylib:arm64e+0x5d6e0)
    #1 FrameStats.init() Frame.swift:28 (RecorderPackageTests:arm64+0x1a0e4)

  Mutex M0 (0x000108f04a20) created at:
    #0 pthread_mutex_init <null> (libclang_rt.tsan_osx_dynamic.dylib:arm64e+0x3c1a0)

  Thread T1 (tid=1234, running) is a GCD worker thread

SUMMARY: ThreadSanitizer: data race Frame.swift:34 in FrameStats.didCapture()
==================
ThreadSanitizer: reported 1 warnings
`;

describe("ThreadSanitizer's reports", () => {
  it("reads a report: what, where, and both stacks", () => {
    assert.deepEqual(parseSanitizerLog(REPORT), [
      {
        kind: "data race",
        summary: "data race Frame.swift:34 in FrameStats.didCapture()",
        access: "Write of size 8 by thread T1",
        stack: "#0 FrameStats.didCapture() Frame.swift:34\n#1 closure #1 in FrameSource.frames(count:every:) Frame.swift:66\n#2 _dispatch_call_block_and_release <null>",
        previous: "Previous read of size 8 by thread T2 (mutexes: write M0)",
        previous_stack: "#0 FrameStats.backlog.getter Frame.swift:46\n#1 Recorder.append(_:) Recorder.swift:30",
      },
    ]);
  });

  it("breaks a sanitizer rule with one row per race, counted once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-tsan-"));
    try {
      const [rule] = parseRules("no-data-races:\n  sanitizer: thread\n");
      assert.deepEqual(await checkRules({ cwd: dir, threadSanitizer: dir }, [rule!]), [{ id: "no-data-races", ok: true, rows: [] }]);
      await writeFile(join(dir, "report.4242"), REPORT);
      await writeFile(join(dir, "report.4243"), REPORT);
      assert.equal((await readSanitizerReports(dir)).length, 1);
      const [result] = await checkRules({ cwd: dir, threadSanitizer: dir }, [rule!]);
      assert.equal(result!.ok, false);
      assert.equal(result!.rows[0]!.summary, "data race Frame.swift:34 in FrameStats.didCapture()");
      // On the seed, nothing ran.
      assert.equal((await checkRules({ cwd: dir }, [rule!]))[0]!.ok, true);
      assert.throws(() => parseRules("x:\n  sanitizer: thread\n  check: ./check.sh\n"), /one of sql, check or sanitizer/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Stands in for xctest: runs the "test" named on its command line against the probe server, as
 * swift/WindTunnelProbe would, and prints what XCTest prints.
 */
const FAKE_XCTEST = `#!/usr/bin/env node
const probe = process.env.WINDTUNNEL_PROBE;
const test = process.argv[3].split("/")[1];
const events = [];
const post = (path, body) => fetch(new URL(path, probe), { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());
async function point(name, body) {
  const reply = await post("point", { name, section: !!body });
  events.push(name + " " + reply.do);
  if (reply.do === "throw") throw new Error("Wind Tunnel failed " + name + " on purpose");
  if (body) {
    await body();
    await post("done", { id: reply.id });
  }
}
async function step(name, body) {
  await post("step", { name, phase: "start" });
  await body();
  await post("step", { name, phase: "end" });
}
const scenarios = {
  async testRace() {
    await step("export", () =>
      Promise.all(["a", "b"].map((who, i) =>
        new Promise((r) => setTimeout(r, i * 30)).then(() => point("export.encode", async () => {
          events.push(who + " in");
          await new Promise((r) => setTimeout(r, 40));
          events.push(who + " out");
        })),
      )),
    );
  },
  async testFail() {
    await step("record", () => point("frame.compress"));
  },
  async testNoSteps() {
    await point("writer.finish");
  },
  async testCrash() {
    await step("stop", async () => process.kill(process.pid, "SIGSEGV"));
  },
  async testCrashWhileHeld() {
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
    await point("export.encode", async () => {});
  },
};
try {
  await scenarios[test]();
  require_fs().writeFileSync(process.env.DATA_DIR + "/events.txt", events.join("\\n"));
  console.log("Test Case '-[Fake.Scenarios " + test + "]' passed (0.1 seconds).");
  console.log("\\t Executed 1 test, with 0 failures (0 unexpected) in 0.1 (0.1) seconds");
} catch (err) {
  console.log("/x/Scenarios.swift:12: error: -[Fake.Scenarios " + test + "] : failed: caught error: \\"" + err.message + "\\"");
  console.log("\\t Executed 1 test, with 1 failure (0 unexpected) in 0.1 (0.1) seconds");
  process.exitCode = 1;
}
function require_fs() { return process.getBuiltinModule("node:fs"); }
`;

describe("a scenario run", () => {
  let root: string;
  let xctest: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-scenario-"));
    xctest = join(root, "xctest");
    await writeFile(xctest, FAKE_XCTEST);
    await chmod(xctest, 0o755);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = async (test: string, yaml = "", variant = "default") => {
    const dir = await mkdtemp(join(root, "run-"));
    const experiment = parse(`scenario: Scenarios/${test}\n${yaml}`);
    const v = variantsOf(experiment, ["app"]).find((x) => x.name === variant) ?? { name: variant };
    const scenario = new ScenarioRun({ experiment, variant: v, xctest, bundle: "Fake.xctest", test: `Fake.Scenarios/${test}`, cwd: root, env: { DATA_DIR: dir }, dir });
    await scenario.execute();
    const events = await readFile(join(dir, "events.txt"), "utf8").catch(() => "");
    return { scenario, events: events.split("\n").filter(Boolean) };
  };

  it("holds two sections at a race barrier and runs them one at a time, in the order asked", async () => {
    const { scenario, events } = await run("testRace", "race: { point: export.encode, order: each }", "2,1");
    assert.deepEqual(scenario.errors, []);
    assert.deepEqual(events, ["export.encode go", "b in", "b out", "export.encode go", "a in", "a out"]);
    assert.deepEqual(scenario.race?.released, ["app (arrival 2)", "app (arrival 1)"]);
    assert.deepEqual(scenario.steps.map((s) => s.step), ["export"]);
    assert.deepEqual(scenario.requests.map((r) => [r.method, r.url, r.step, r.harness?.at(-1)]), [
      ["POINT", "export.encode", "export", "released second"],
      ["POINT", "export.encode", "export", "released first"],
    ]);
    assert.deepEqual(scenario.warnings(), []);
  });

  it("fails the code at a point; the scenario's failure is the run's error, in its step", async () => {
    const { scenario } = await run("testFail", "perturb: [{ do: fail, point: frame.compress }]");
    assert.deepEqual(scenario.errors, [{ tab: "app", step: "record", message: 'failed: caught error: "Wind Tunnel failed frame.compress on purpose" (line 12)' }]);
    assert.deepEqual(scenario.requests[0]!.harness, ["the code threw here: failed by the harness"]);
    assert.equal(scenario.requests[0]!.sent, null);
  });

  it("cancels at a point; without steps, the whole scenario is one, named after its test", async () => {
    const { scenario, events } = await run("testNoSteps", "perturb: [{ do: cancel, point: writer.finish }, { do: delay, point: nowhere, ms: 5 }]");
    assert.deepEqual(events, ["writer.finish cancel"]);
    assert.deepEqual(scenario.steps.map((s) => s.step), ["testNoSteps"]);
    assert.equal(scenario.requests[0]!.step, "testNoSteps");
    assert.deepEqual(scenario.warnings(), ["delay point nowhere: the code never reached it"]);
  });

  it("reports a crash in the step it happened in", async () => {
    const { scenario } = await run("testCrash");
    assert.match(scenario.errors[0]!.message, /^the scenario crashed \(SIGSEGV\)/);
    assert.equal(scenario.errors[0]!.step, "stop");
    assert.equal(scenario.steps[0]!.error, "the scenario ended during this step");
  });

  it("lets go of a point held at the barrier when its process dies", async () => {
    const started = Date.now();
    const { scenario } = await run("testCrashWhileHeld", "race: { point: export.encode, timeout: 10s }");
    assert.ok(Date.now() - started < 5_000, "didn't wait for the race's timeout");
    assert.match(scenario.errors[0]!.message, /^the scenario crashed \(SIGKILL\)/);
    assert.equal(scenario.race?.arrived.length, 1);
    assert.deepEqual(scenario.warnings(), ["race on point export.encode: only 1 of 2 arrived; released after the timeout"]);
  });

  it("says when the test isn't in the bundle", async () => {
    const dir = await mkdtemp(join(root, "run-"));
    const empty = join(root, "empty-xctest");
    await writeFile(empty, "#!/bin/sh\necho \"\t Executed 0 tests, with 0 failures (0 unexpected) in 0.0 (0.0) seconds\"\n");
    await chmod(empty, 0o755);
    const scenario = new ScenarioRun({ experiment: parse("scenario: Scenarios/testGone"), variant: { name: "default" }, xctest: empty, bundle: "Fake.xctest", test: "Fake.Scenarios/testGone", cwd: root, env: { DATA_DIR: dir }, dir });
    await scenario.execute();
    assert.deepEqual(scenario.errors.map((e) => e.message), ["no test Fake.Scenarios/testGone in Fake.xctest"]);
  });
});

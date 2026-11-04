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
import { findScenario, isTestFile, probePoints, scenarioHost } from "../src/mac/swift.ts";
import { hostedTests, xcodeBuildCommand } from "../src/mac/xcode.ts";
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

  it("names an Xcode project with its scheme, or neither", () => {
    const config = parseConfig("app:\n  kind: mac\nmac:\n  project: Reco.xcodeproj\n  scheme: Reco\n  sanitizer: none\n");
    assert.deepEqual(config.mac, { dir: ".", project: "Reco.xcodeproj", scheme: "Reco", sanitizer: "none", env: {} });
    assert.throws(() => parseConfig("app:\n  kind: mac\nmac:\n  project: Reco.xcodeproj\n"), /mac.scheme: the scheme that builds Reco.xcodeproj/);
    assert.throws(() => parseConfig("app:\n  kind: mac\nmac:\n  scheme: Reco\n"), /set mac.project too/);
    assert.throws(() => parseConfig("app:\n  kind: mac\nmac:\n  project: Reco\n  scheme: Reco\n"), /an .xcodeproj or .xcworkspace/);
    assert.throws(() => parseConfig("app:\n  kind: mac\nmac:\n  project: A.xcworkspace\n  scheme: A\n  tests: x.xctest\n"), /found in its build/);
  });

  it("builds an Xcode project for testing, ad-hoc signed, into $DERIVED_DATA", () => {
    const mac = parseConfig("app:\n  kind: mac\nmac:\n  project: My App.xcworkspace\n  scheme: App\n").mac!;
    const command = xcodeBuildCommand(mac, "thread");
    assert.match(command, /^xcodebuild -workspace 'My App.xcworkspace' -scheme App -configuration Debug -destination 'platform=macOS,arch=\w+' -derivedDataPath "\$DERIVED_DATA" -enableThreadSanitizer YES build-for-testing -quiet /);
    assert.match(command, /CODE_SIGN_IDENTITY=- .* ENABLE_HARDENED_RUNTIME=NO$/);
    assert.ok(!xcodeBuildCommand({ ...mac, project: "Reco.xcodeproj" }, "none").includes("Sanitizer"));
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

const XCODE_SCENARIOS = `import XCTest
@testable import Reco

final class WindTunnelScenarios: XCTestCase {
    func testEditThenClose() async throws {
        await Probe.step("open") {}
        await Probe.step("close") {}
    }
}
`;

const RECO_MAIN = `import WindTunnelProbe

@main
enum RecoMain {
    static func main() {
        // Probe.hostScenario() in a comment doesn't count
        Probe.hostScenario()
        RecoApp.main()
    }
}
`;

describe("reading an Xcode project", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-xcode-"));
    await mkdir(join(root, "Reco.xcodeproj"), { recursive: true });
    await mkdir(join(root, "Reco"), { recursive: true });
    await mkdir(join(root, "RecoTests"), { recursive: true });
    await writeFile(join(root, "RecoTests", "WindTunnelScenarios.swift"), XCODE_SCENARIOS);
    await writeFile(join(root, "Reco", "RecoMain.swift"), RECO_MAIN);
    await writeFile(join(root, "Reco", "TakeWriter.swift"), WRITER);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds a scenario in any folder of tests, in the test bundle's module", async () => {
    assert.deepEqual(await findScenario(root, "WindTunnelScenarios/testEditThenClose", undefined, { module: "RecoTests" }), {
      test: "RecoTests.WindTunnelScenarios/testEditThenClose",
      file: "RecoTests/WindTunnelScenarios.swift",
      line: 5,
      steps: ["open", "close"],
    });
    // Before the build, the module isn't known yet; the steps are.
    assert.equal((await findScenario(root, "WindTunnelScenarios/testEditThenClose", undefined, {}))?.test, "WindTunnelScenarios/testEditThenClose");
    assert.equal(await findScenario(root, "Other.WindTunnelScenarios/testEditThenClose", undefined, { module: "RecoTests" }), undefined);
    // Read as a Swift package, it has no Tests/ folder.
    assert.equal(await findScenario(root, "WindTunnelScenarios/testEditThenClose"), undefined);
  });

  it("finds where the app hosts scenarios, and leaves tests out of its probe points", async () => {
    assert.deepEqual(await scenarioHost(root), { file: "Reco/RecoMain.swift", line: 7 });
    assert.deepEqual((await probePoints(root)).map((p) => p.name), ["frame.compress", "writer.finish"]);
    assert.ok(isTestFile("RecoTests/A.swift", "import Testing\n"));
    assert.ok(isTestFile("Tests/X/A.swift", ""));
    assert.ok(!isTestFile("Reco/A.swift", "import Foundation // XCTest\n"));
  });

  it("reads the app-hosted test bundles a build left, from its .xctestrun", async () => {
    const products = join(root, "dd", "Build", "Products");
    const app = join(products, "Debug", "Reco.app");
    await mkdir(join(app, "Contents"), { recursive: true });
    await writeFile(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Reco</string></dict></plist>`,
    );
    const target = (name: string, hosted: boolean, ui = false) => `<dict>
      <key>BlueprintName</key><string>${name}</string><key>ProductModuleName</key><string>${name}</string>
      <key>IsAppHostedTestBundle</key><${hosted}/><key>IsUITestBundle</key><${ui}/>
      <key>TestHostPath</key><string>__TESTROOT__/Debug/Reco.app</string>
      <key>TestBundlePath</key><string>__TESTHOST__/Contents/PlugIns/${name}.xctest</string>
      <key>TestingEnvironmentVariables</key><dict>
        <key>DYLD_FRAMEWORK_PATH</key><string>__TESTROOT__/Debug:__PLATFORMS__/MacOSX.platform/Developer/Library/Frameworks</string>
        <key>DYLD_INSERT_LIBRARIES</key><string>__TESTHOST__/Contents/Frameworks/libXCTestBundleInject.dylib</string>
      </dict></dict>`;
    await writeFile(
      join(products, "Reco_Reco_macosx26.0-arm64.xctestrun"),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
        <key>TestConfigurations</key><array><dict><key>TestTargets</key><array>
          ${target("RecoTests", true)}${target("RecoUITests", true, true)}${target("LogicTests", false)}
        </array></dict></array></dict></plist>`,
    );
    const [tests, ...others] = await hostedTests(join(root, "dd"));
    assert.equal(others.length, 0);
    assert.equal(tests!.module, "RecoTests");
    assert.equal(tests!.executable, join(app, "Contents", "MacOS", "Reco"));
    assert.equal(tests!.bundle, join(app, "Contents", "PlugIns", "RecoTests.xctest"));
    assert.match(tests!.xctest, /Platforms\/MacOSX.platform\/Developer\/Library\/Frameworks\/XCTest.framework\/XCTest$/);
    // XCTest's own injector is left out: the app loads the bundle itself.
    assert.deepEqual(Object.keys(tests!.env), ["DYLD_FRAMEWORK_PATH", "DYLD_LIBRARY_PATH"]);
    assert.ok(tests!.env.DYLD_FRAMEWORK_PATH!.startsWith(`${join(products, "Debug")}:`));
    assert.ok(!tests!.env.DYLD_FRAMEWORK_PATH!.includes("__"));
    assert.match(tests!.env.DYLD_LIBRARY_PATH!, /MacOSX.platform\/Developer\/usr\/lib$/);
  });
});

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
// As xctest, the test is on the command line; as an Xcode project's app, in WINDTUNNEL_SCENARIO.
const test = (process.env.WINDTUNNEL_SCENARIO ?? process.argv[3]).split("/")[1];
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
async function step(name, body, picture) {
  await post("step", { name, phase: "start" });
  await body();
  await post("step", { name, phase: "end", ...(picture ? { picture } : {}) });
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
  async testPicture() {
    // What the step showed, as swift/WindTunnelProbe sends it: a base64 JPEG.
    await step("open", async () => {}, Buffer.from("not really a jpeg").toString("base64"));
    await step("close", async () => {});
  },
  async testLeaveHeld() {
    // Work the test doesn't wait for: the process exits while the point is held.
    void point("export.pumped").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
  },
  async testCrashWhileHeld() {
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
    await point("export.encode", async () => {});
  },
};
try {
  await scenarios[test]();
  if (process.env.WINDTUNNEL_SCENARIO) events.push("hosted " + process.env.WINDTUNNEL_SCENARIO + " " + process.env.WINDTUNNEL_TESTS + " " + process.env.WINDTUNNEL_XCTEST);
  require_fs().writeFileSync(process.env.DATA_DIR + "/events.txt", events.join("\\n"));
  console.log("Test Case '-[Fake.Scenarios " + test + "]' passed (0.1 seconds).");
  console.log("\\t Executed 1 test, with 0 failures (0 unexpected) in 0.1 (0.1) seconds");
  // As xctest does: the process ends with the test, whatever it left running.
  process.exit(0);
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
    assert.equal(scenario.steps[0]!.error, "the scenario crashed (SIGSEGV) during this step");
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

  it("keeps what a step showed as its screenshot, as a page's step has one", async () => {
    const dir = await mkdtemp(join(root, "run-"));
    const scenario = new ScenarioRun({ experiment: parse("scenario: Scenarios/testPicture"), variant: { name: "default" }, xctest, bundle: "Fake.xctest", test: "Fake.Scenarios/testPicture", cwd: root, env: { DATA_DIR: dir }, dir });
    await scenario.execute();
    assert.deepEqual(scenario.steps.map((s) => [s.step, s.shot]), [["open", "step-01-app.jpg"], ["close", undefined]]);
    assert.equal(await readFile(join(dir, "screens", "step-01-app.jpg"), "utf8"), "not really a jpeg");
  });

  it("warns when the scenario ended with a point still held: the code after it never ran", async () => {
    const { scenario } = await run("testLeaveHeld", "perturb: [{ do: delay, point: export.pumped, ms: 600 }]");
    assert.deepEqual(scenario.errors, []);
    assert.equal(scenario.warnings().length, 1);
    assert.match(scenario.warnings()[0]!, /^point export.pumped: still held when the scenario ended \(at \d+ ms; let go at \d+ ms\), so the code after it never ran/);
  });

  it("runs an Xcode project's scenario inside its app: the app's executable, told the test, the bundle and XCTest", async () => {
    const dir = await mkdtemp(join(root, "run-"));
    const experiment = parse("scenario: Scenarios/testRace\nrace: { point: export.encode, order: [2, 1] }");
    const host = { module: "Fake", bundle: "/b/Fake.xctest", executable: xctest, xctest: "/x/XCTest", env: { DYLD_FRAMEWORK_PATH: "/f" } };
    const scenario = new ScenarioRun({ experiment, variant: variantsOf(experiment, ["app"])[0]!, host, test: "Fake.Scenarios/testRace", cwd: root, env: { DATA_DIR: dir }, dir });
    await scenario.execute();
    assert.deepEqual(scenario.errors, []);
    const events = (await readFile(join(dir, "events.txt"), "utf8")).split("\n");
    // (DYLD_ variables are passed too; macOS drops them for this fake, which starts through /usr/bin/env.)
    assert.deepEqual(events.slice(-1), ["hosted Fake.Scenarios/testRace /b/Fake.xctest /x/XCTest"]);
    assert.deepEqual(events.filter((e) => / (in|out)$/.test(e)), ["b in", "b out", "a in", "a out"]);
  });
});

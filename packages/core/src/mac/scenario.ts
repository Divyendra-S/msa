import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { killTree } from "../exec.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { type Experiment, isNetworkPerturbation, type RaceOrder, type Variant } from "../runner/experiment.ts";
import { Network, newGroup, type NetworkTab, type RaceRecord, type RequestRecord } from "../runner/network.ts";
import type { FlowError, StepRecord } from "../runner/rep.ts";
import { type PointCall, ProbeServer } from "./probe.ts";
import type { HostedTests } from "./xcode.ts";

/** The one tab of a Mac app's run: its code, as the scenario drives it. */
export const SCENARIO_TAB = "app";

const LOG_TAIL = 8;

export interface ScenarioInput {
  experiment: Experiment;
  variant: Variant;
  /** A Swift package's tests: Xcode's xctest and the test bundle. */
  xctest?: string;
  bundle?: string;
  /** An Xcode project's: the app they run inside, through `Probe.hostScenario()`. */
  host?: HostedTests;
  /** `Module.Class/testMethod`. */
  test: string;
  /** Where the test runs: the package's (or project's) folder in the version's worktree. */
  cwd: string;
  /** DATA_DIR, HOME, the database's variables, `mac.env`. */
  env: Record<string, string>;
  /** ThreadSanitizer's runtime, loaded into xctest at start (an app built with it has its own), and the folder its reports go to. */
  sanitizer?: { library?: string; reports: string };
  /** The run's folder: `scenario.log` goes there. */
  dir: string;
}

/** Test processes still running, so a stopped run can end them. */
const live = new Set<ChildProcess>();

/** Ends every scenario still running (the run was stopped). */
export function stopScenarios(): void {
  for (const child of live) killTree(child, "SIGKILL");
  live.clear();
}

/**
 * One run of a Swift Mac app's scenario: its XCTest method in its own process, the probe points
 * it reaches caught at the seam (held, delayed, failed, cancelled, raced), and its steps.
 */
export class ScenarioRun {
  readonly t0 = Date.now();
  readonly steps: StepRecord[] = [];
  readonly errors: FlowError[] = [];
  timedOut = false;
  /** When the test's process exited by itself (not killed or crashed), from t0. */
  private exitedAt?: number;
  private readonly input: ScenarioInput;
  private readonly network: Network;
  private readonly tab: NetworkTab;
  /** Step pictures saved so far. */
  private pictures = 0;
  /** Steps started and not yet ended, innermost last. */
  private readonly running: StepRecord[] = [];

  constructor(input: ScenarioInput) {
    this.input = input;
    const race = input.experiment.race;
    this.network = new Network({
      t0: this.t0,
      perturbations: input.experiment.perturb.filter(isNetworkPerturbation),
      race: race && { ...race, count: race.count ?? 2, order: (input.variant.order ?? race.order) as RaceOrder },
      client: "app",
    });
    const running = this.running;
    this.tab = {
      label: SCENARIO_TAB,
      group: newGroup(),
      get stepName() {
        return running.at(-1)?.step;
      },
      takeInterruption: () => undefined,
      interrupt: async () => undefined,
    };
  }

  get requests(): RequestRecord[] {
    return this.network.log;
  }

  get race(): RaceRecord | undefined {
    return this.network.race;
  }

  /** Runs the test to its end, then lets go of anything still held. */
  async execute(): Promise<void> {
    const port = await allocatePort();
    let server: ProbeServer | undefined;
    try {
      server = await ProbeServer.start(port, {
        point: (call) => this.point(call),
        step: (name, phase, error, picture) => this.step(name, phase, error, picture),
      });
      await this.runTest(server.url);
    } finally {
      // The process is gone: its unfinished sections are over, and nothing waits for held points.
      await server?.close();
      await this.network.drain();
      releasePort(port);
    }
    this.finishSteps();
  }

  /** Parts of the experiment that never took effect: a pass then proves less than it seems. */
  warnings(): string[] {
    const out = this.network.unused().map((p) => `${p.do} ${p.request}${p.step ? ` (step ${p.step})` : ""}: the code never reached it`);
    // A point let go after the process was gone: the code after it never ran.
    const exited = this.exitedAt;
    for (const r of this.network.log) {
      if (exited !== undefined && r.method === "POINT" && typeof r.sent === "number" && r.sent > exited) {
        out.push(`point ${r.url}: still held when the scenario ended (at ${exited} ms; let go at ${r.sent} ms), so the code after it never ran; wait for that work in the scenario`);
      }
    }
    const race = this.input.experiment.race;
    if (race) {
      const record = this.network.race;
      const count = race.count ?? 2;
      if (!record) out.push(`race on ${race.request}: the code never reached it, nothing was held`);
      else if (record.timedOut && record.arrived.length < count) {
        out.push(`race on ${race.request}: only ${record.arrived.length} of ${count} arrived; released after the timeout`);
      }
    }
    return out;
  }

  now(): number {
    return Date.now() - this.t0;
  }

  private point(call: PointCall): void {
    const step = this.tab.stepName;
    const record = this.network.record({ tab: SCENARIO_TAB, ...(step ? { step } : {}), method: "POINT", url: call.name, type: "point" });
    this.network.opened(record, this.tab.group);
    void this.network.handle(call, this.tab, record).then(
      () => this.network.settle(record),
      (err: Error) => this.network.settle(record, err.message.split("\n")[0]),
    );
  }

  private step(name: string, phase: "start" | "end", error?: string, picture?: Buffer): void {
    if (phase === "start") {
      const record: StepRecord = { tab: SCENARIO_TAB, step: name, start: this.now(), end: this.now(), actions: [], quiet: true };
      this.steps.push(record);
      this.running.push(record);
      return;
    }
    const index = this.running.findLastIndex((s) => s.step === name);
    if (index < 0) return;
    const [record] = this.running.splice(index, 1);
    record!.end = this.now();
    if (error) record!.error = error;
    // What the step showed, drawn off screen by the app: its screenshot, as a page's step has one.
    if (picture?.length) {
      const name = `step-${String(++this.pictures).padStart(2, "0")}-${SCENARIO_TAB}.jpg`;
      mkdirSync(join(this.input.dir, "screens"), { recursive: true });
      writeFileSync(join(this.input.dir, "screens", name), picture);
      record!.shot = name;
    }
  }

  private async runTest(probe: string): Promise<void> {
    const { input } = this;
    const log = join(input.dir, "scenario.log");
    const { sanitizer } = input;
    if (sanitizer) await mkdir(sanitizer.reports, { recursive: true });
    const { host } = input;
    // An Xcode project's test runs inside its app: the app's own executable, which loads XCTest and the bundle.
    const command = host ? host.executable : input.xctest!;
    const args = host ? [] : ["-XCTest", input.test, input.bundle!];
    const bundle = host ? host.bundle : input.bundle!;
    const fd = openSync(log, "a");
    let child: ChildProcess;
    try {
      // Started directly, not through a shell: macOS drops DYLD_ variables when it runs /bin/sh.
      child = spawn(command, args, {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...input.env,
          ...(host ? { ...host.env, WINDTUNNEL_SCENARIO: input.test, WINDTUNNEL_TESTS: host.bundle, WINDTUNNEL_XCTEST: host.xctest } : {}),
          WINDTUNNEL_PROBE: probe,
          NSUnbufferedIO: "YES",
          ...(sanitizer
            ? {
                ...(sanitizer.library ? { DYLD_INSERT_LIBRARIES: sanitizer.library } : {}),
                TSAN_OPTIONS: `log_path=${join(sanitizer.reports, "report")} halt_on_error=0 abort_on_error=0`,
              }
            : {}),
        },
        stdio: ["ignore", fd, fd],
        detached: true,
      });
    } finally {
      closeSync(fd);
    }
    live.add(child);
    const timer = setTimeout(() => {
      this.timedOut = true;
      killTree(child, "SIGKILL");
    }, input.experiment.timeout);
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("error", () => resolve({ code: -1, signal: null }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    live.delete(child);
    // A crash or a timeout is the run's error already.
    if (!exit.signal) this.exitedAt = this.now();

    const output = await readFile(log, "utf8").catch(() => "");
    const step = () => this.running.at(-1)?.step ?? this.steps.at(-1)?.step;
    const fail = (message: string) => this.errors.push({ tab: SCENARIO_TAB, ...(step() ? { step: step()! } : {}), message });
    const tail = () => output.trimEnd().split("\n").slice(-LOG_TAIL).join("\n");
    if (this.timedOut) return void fail(`the scenario did not finish in ${input.experiment.timeout / 1000} s`);
    if (exit.code === -1) return void fail(`could not start ${command}`);
    if (exit.signal) return void fail(`the scenario crashed (${exit.signal})\n${tail()}`);
    const executed = [...output.matchAll(/Executed (\d+) tests?, with (\d+) failures?/g)].at(-1);
    if (!executed || executed[1] === "0") {
      return void fail(exit.code === 0 ? `no test ${input.test} in ${bundle}` : `the scenario exited with ${exit.code}\n${tail()}`);
    }
    // `…/Scenarios.swift:31: error: -[Module.Class testX] : XCTAssertEqual failed: …`
    for (const m of output.matchAll(/^.*?:(\d+): error: -\[\S+ \S+\] : (.*)$/gm)) fail(`${m[2]!.trim()} (line ${m[1]})`);
    const skipped = /Test Case '.*' skipped/.test(output) ? /^.*: -\[\S+ \S+\] : Test skipped(?: - )?(.*)$/m.exec(output) : null;
    if (skipped) fail(`the scenario was skipped${skipped[1] ? `: ${skipped[1]}` : ""}`);
    if (exit.code !== 0 && this.errors.length === 0) fail(`the scenario failed (exit ${exit.code})\n${tail()}`);
  }

  /** Ends steps the scenario never ended; without any, the whole scenario is one step, named after its method. */
  private finishSteps(): void {
    const end = this.now();
    for (const record of this.running.splice(0)) {
      record.end = end;
      // What ended it, when the run knows (a crash), in a line.
      const cause = this.errors.find((e) => e.step === record.step)?.message.split("\n")[0];
      record.error ??= cause ? `${cause} during this step` : "the scenario ended during this step";
    }
    if (this.steps.length > 0) return;
    const name = this.input.test.split("/").at(-1)!;
    const error = this.errors[0]?.message;
    this.steps.push({ tab: SCENARIO_TAB, step: name, start: 0, end, actions: [], quiet: true, ...(error ? { error } : {}) });
    for (const r of this.network.log) r.step ??= name;
    for (const e of this.errors) e.step ??= name;
  }
}

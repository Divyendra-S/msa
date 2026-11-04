import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { Emulators } from "../android/emulators.ts";
import { type AndroidSdk, findAndroidSdk } from "../android/sdk.ts";
import { Simulators } from "../ios/simulators.ts";
import { buildWebDriverAgent, findWebDriverAgentSource, WebDriverAgent, type WebDriverAgentBuild } from "../ios/wda.ts";
import { Appium } from "../phone/appium.ts";
import { type Branch, Branches } from "../branches/branches.ts";
import { browserFor } from "../browser.ts";
import type { CodeVersion, CodeVersionSpec, MacTests } from "../branches/code-versions.ts";
import { CONFIG_FILE, ConfigError, expandVars, type MacConfig } from "../config.ts";
import type { Database } from "../database.ts";
import { CommandError, runScript, sh } from "../exec.ts";
import { ScenarioRun, stopScenarios } from "../mac/scenario.ts";
import { type Sanitizer, threadSanitizerLibrary, threadSanitizerProblem } from "../mac/sanitizer.ts";
import { findScenario, scenarioHost } from "../mac/swift.ts";
import type { TestUser } from "../flow-api.ts";
import { checkRules, loadRules, phoneFilesOf, type Rule, type RuleResult } from "../rules.ts";
import { type DbSnapshot, diffSnapshots, snapshotDatabase } from "./db-diff.ts";
import { runFacts } from "./facts.ts";
import {
  checkExperiment,
  type Experiment,
  experimentUsers,
  tabLabels,
  type Variant,
  variantsOf,
} from "./experiment.ts";
import { findFlowFile, LOGIN_FLOW, type LoadedFlow, loadFlow } from "./flows.ts";
import { experimentInputs } from "./inputs.ts";
import { AndroidDriver } from "./android-driver.ts";
import { IosDriver } from "./ios-driver.ts";
import type { Driver } from "./driver.ts";
import { PlaywrightDriver } from "./playwright-driver.ts";
import { Rep, type TraceMode } from "./rep.ts";
import { RunStore, writeJson } from "./store.ts";

export type RepOutcome = "ok" | "broken" | "error";
/** pass: every run held every rule · fail: a rule broke in every run · flaky: mixed · error: the flow could not finish. */
export type Outcome = "pass" | "fail" | "flaky" | "error";

export interface RunOptions {
  /** Code to test (default: the working tree). */
  version?: CodeVersionSpec | CodeVersion;
  /** Overrides each experiment's `repeat`. */
  repeat?: number;
  keepDatabase?: boolean;
  /** Playwright traces (default `failures`: kept for runs that broke a rule or errored). */
  trace?: TraceMode;
  headed?: boolean;
  /**
   * Where the harness catches the browser's calls: Playwright's routes (default), or an HTTP
   * proxy in front of the app, the seam phones and desktop apps use. Default: $WINDTUNNEL_SEAM.
   */
  seam?: Seam;
  onRep?: (rep: RepSummary & { experiment: string }) => void;
}

export type Seam = "route" | "proxy";

export interface RepSummary {
  rep: number;
  variant: string;
  outcome: RepOutcome;
  /** Ids of the rules this run broke. */
  broken: string[];
  error?: string;
  durationMs: number;
  /** Database changes, e.g. `orders +2 · products ~1`. */
  diff: string;
  /** Parts of the experiment that never took effect (a perturbation matched nothing…). */
  warnings?: string[];
}

export interface VariantResult {
  variant: string;
  runs: number;
  ok: number;
  broken: number;
  errors: number;
  outcome: Outcome;
  /** Share of runs that disagree with the most common result. */
  flakeRate: number;
  /** Rule id → number of runs that broke it. */
  rules: Record<string, number>;
  firstBroken?: number;
  firstError?: { rep: number; message: string };
}

export interface ExperimentResult {
  runId: string;
  experiment: string;
  version: { id: string; label: string; tree?: string };
  outcome: Outcome;
  variants: VariantResult[];
  reps: RepSummary[];
  startedAt: string;
  durationMs: number;
  dir: string;
  /** Warnings from its runs, each with the number of runs that had it. */
  warnings?: string[];
  /** Hash of the experiment, its flows and its rules (see experimentInputs). */
  inputs?: string;
  /** Requests the app received, `POST /api/orders` (page loads too, webhooks included): what the experiment exercised. */
  touched?: string[];
}

/** The project's own test command on one code version. */
export interface TestRun {
  command: string;
  version: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  log: string;
  /** Last lines of the output. */
  tail: string[];
}

/** What runs on Android phones need, started with the first one: the emulators and Appium. */
interface AndroidRuntime {
  sdk: AndroidSdk;
  emulators: Emulators;
  appium: Appium;
}

/** What runs on iOS simulators need, started with the first one. */
interface IosRuntime {
  simulators: Simulators;
  wda: WebDriverAgentBuild;
  /** WebDriverAgent on each simulator, started when a run first uses it. */
  agents: Map<string, Promise<WebDriverAgent>>;
}

/** What a Mac app's runs on one code version need: its tests as built, and how to start them. */
interface MacSetup {
  /** xctest, for a Swift package's bundle; an Xcode project's tests run inside its app instead. */
  xctest?: string;
  tests: MacTests;
  /** The Swift package's (or Xcode project's) folder in the version's worktree. */
  cwd: string;
  /** ThreadSanitizer's runtime, loaded into xctest when the build has it (an app built with it carries its own). */
  library?: string;
  /** Whether the build has ThreadSanitizer, whose reports the run then collects. */
  sanitized: boolean;
}

/** The phones of a run, leased from the emulators or simulators; none for web and desktop apps. */
interface PhoneLease {
  acquire(n: number): Promise<string[]>;
  release(ids: string[]): void;
}

/** Runs experiments: each repetition in its own branch, all at once up to `parallel`. */
export class Runner {
  readonly branches: Branches;
  readonly store: RunStore;
  private browser?: Promise<Browser>;
  private android?: Promise<AndroidRuntime>;
  private ios?: Promise<IosRuntime>;
  private readonly macSetups = new Map<string, Promise<MacSetup>>();
  private sanitizerChecked?: Promise<string | undefined>;
  private headed = false;
  private readonly baselines = new Map<string, Promise<DbSnapshot>>();
  /** Old runs are pruned once per runner, before its first run. */
  private pruned?: Promise<number>;

  constructor(branches: Branches) {
    this.branches = branches;
    this.store = new RunStore(branches.project.stateDir);
  }

  static async open(cwd?: string): Promise<Runner> {
    return new Runner(await Branches.open(cwd));
  }

  get project() {
    return this.branches.project;
  }

  /** Validates experiments against the project; throws a ConfigError listing every problem. */
  async validate(experiments: Experiment[]): Promise<{ rules: Rule[]; warnings: string[] }> {
    const { kind } = this.project.config.app;
    let rules = await loadRules(this.project);
    const problems: string[] = [];
    const warnings: string[] = [];
    for (const rule of rules) {
      if (rule.phone && kind !== "ios") problems.push(`rule ${rule.id}: phone: rules read an iOS app's data on its simulator (app.kind: ios)`);
      if (rule.sanitizer && kind !== "mac") problems.push(`rule ${rule.id}: sanitizer: rules are for Swift Mac apps built with ThreadSanitizer (app.kind: mac)`);
    }
    // Built without ThreadSanitizer, its rules can't be checked: left out, and said so.
    const unchecked = kind === "mac" && sanitizerOf(this.project.config.mac!) === "none" ? rules.filter((r) => r.sanitizer) : [];
    if (unchecked.length > 0) {
      rules = rules.filter((r) => !r.sanitizer);
      for (const rule of unchecked) {
        const named = experiments.filter((e) => e.rules !== "all" && e.rules.includes(rule.id));
        if (named.length) problems.push(`${named.map((e) => e.id).join(", ")}: rule ${rule.id} needs ThreadSanitizer (mac.sanitizer: thread)`);
        else warnings.push(`rule ${rule.id} is not checked: built without ThreadSanitizer`);
      }
    }
    for (const experiment of experiments) {
      const result = await checkExperiment(experiment, this.project, rules);
      problems.push(...result.errors.map((e) => `${experiment.id}: ${e}`));
      warnings.push(...result.warnings.map((w) => `${experiment.id}: ${w}`));
    }
    if (problems.length > 0) throw new ConfigError(`invalid experiments\n${problems.map((p) => `  ${p}`).join("\n")}`);
    return { rules, warnings: [...new Set(warnings)] };
  }

  /** Runs every rule on a fresh copy of the seed data, where each must hold; returns the problems. */
  async checkRulesOnSeed(rules: Rule[], version: CodeVersionSpec | CodeVersion = {}): Promise<string[]> {
    const results = await this.branches.withSeedCopy(version, (copy) =>
      checkRules({ database: copy.database, cwd: this.project.root, env: copy.env }, rules),
    );
    return results.flatMap((r) =>
      r.error
        ? [`rule ${r.id}: SQL error: ${r.error}`]
        : r.ok
          ? []
          : [`rule ${r.id} already breaks on the seed data (${r.rows.length} row(s)): fix the SQL or the seed`],
    );
  }

  /**
   * Runs `app.test` in a version's worktree, with DATABASE_URL on a fresh copy of the seed (and
   * DATA_DIR on a new folder) so tests never touch real data. Undefined when the project has no test command.
   */
  async runTests(spec: CodeVersionSpec | CodeVersion): Promise<TestRun | undefined> {
    const { test: command, testTimeoutMs } = this.project.config.app;
    if (!command) return undefined;
    const prepared = await this.branches.prepare(spec);
    const version = prepared.version.id;
    const log = join(this.project.stateDir, "logs", "tests", `${version}-${Date.now().toString(36)}.log`);
    const started = Date.now();
    return this.branches.withSeedCopy(prepared.version, async (copy) => {
      let exitCode = 0;
      try {
        await sh(command, { cwd: prepared.appDir, env: { ...copy.env, CI: "1" }, logFile: log, timeoutMs: testTimeoutMs });
      } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        exitCode = err.result.code;
      }
      const output = await readFile(log, "utf8").catch(() => "");
      return {
        command,
        version,
        ok: exitCode === 0,
        exitCode,
        durationMs: Date.now() - started,
        log,
        tail: output.trimEnd().split("\n").slice(-15),
      };
    });
  }

  async run(experiments: Experiment[], options: RunOptions = {}): Promise<ExperimentResult[]> {
    const { rules } = await this.validate(experiments);
    // A phone's calls can only be caught at the proxy in front of its server.
    options = { ...options, seam: this.onPhones() ? "proxy" : (options.seam ?? seamFromEnv()) };
    const spec = options.version ?? {};
    const version = "tree" in spec ? spec : await this.branches.versions.resolve(spec);
    await this.branches.prepare(version);
    // A Mac app's tests are built before its runs start, so a build error is one error, not one per run.
    if (this.project.config.mac) await this.macSetup(version);
    this.pruned ??= this.store.prune();
    await this.pruned;
    this.headed = !!options.headed;
    return Promise.all(experiments.map((experiment) => this.runExperiment(experiment, version, rules, options)));
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
    stopScenarios();
    // The emulators keep running for the next runs; `windtunnel devices stop` shuts them down.
    if (this.android) await (await this.android.catch(() => undefined))?.appium.close();
    const ios = this.ios && (await this.ios.catch(() => undefined));
    for (const agent of ios?.agents.values() ?? []) await (await agent.catch(() => undefined))?.stop();
    await this.branches.close();
  }

  private async runExperiment(
    experiment: Experiment,
    version: CodeVersion,
    allRules: Rule[],
    options: RunOptions,
  ): Promise<ExperimentResult> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const { id: runId, dir } = await this.store.create();
    await writeJson(`${dir}/experiment.json`, experiment);
    const rules = experiment.rules === "all" ? allRules : allRules.filter((r) => experiment.rules.includes(r.id));
    // A Mac app's experiments run a scenario, not a flow.
    const flow = experiment.flow === undefined ? undefined : await loadFlow(this.project.stateDir, experiment.flow);
    const login = flow && (await findFlowFile(this.project.stateDir, LOGIN_FLOW))
      ? await loadFlow(this.project.stateDir, LOGIN_FLOW)
      : undefined;
    const users = experimentUsers(experiment, this.project);
    const repeat = options.repeat ?? experiment.repeat;
    const jobs = variantsOf(experiment, users).flatMap((variant) =>
      Array.from({ length: repeat }, () => variant),
    );
    const inputs = await experimentInputs(this.project, experiment, allRules);
    const touched = new Set<string>();

    const reps = await Promise.all(
      jobs.map(async (variant, i) => {
        const summary = await this.runRep({ experiment, variant, version, rules, flow, login, users, rep: i + 1, dir, options, touched });
        options.onRep?.({ ...summary, experiment: experiment.id });
        return summary;
      }),
    );

    const variants = [...new Set(jobs.map((v) => v.name))].map((name) => summarizeVariant(name, reps));
    const warned = new Map<string, number>();
    for (const r of reps) for (const w of r.warnings ?? []) warned.set(w, (warned.get(w) ?? 0) + 1);
    const result: ExperimentResult = {
      runId,
      experiment: experiment.id,
      version: { id: version.id, label: version.label, tree: version.tree },
      outcome: worst(variants.map((v) => v.outcome)),
      variants,
      reps,
      startedAt,
      durationMs: Date.now() - started,
      dir,
      ...(warned.size ? { warnings: [...warned].map(([w, n]) => `${w} (${n}/${reps.length} runs)`) } : {}),
      inputs,
      touched: [...touched].sort(),
    };
    await this.store.finish(dir, result, {
      id: runId,
      experiment: experiment.id,
      version: version.id,
      startedAt,
      outcome: result.outcome,
      headline: headline(result),
    });
    return result;
  }

  private async runRep(job: RepJob): Promise<RepSummary> {
    if (this.project.config.mac) return this.runScenario(job);
    const started = Date.now();
    const dir = this.store.repDir(job.dir, job.rep);
    await mkdir(dir, { recursive: true });
    const trace = job.options.trace ?? "failures";
    const seam = job.options.seam ?? "route";
    let branch: Branch;
    let phones: string[] = [];
    try {
      // Phones first: a run waiting for one shouldn't hold a server meanwhile.
      if (this.onPhones()) phones = await (await this.phoneLease()).acquire(job.users.length);
      branch = await this.branches.create(job.version, {
        logDir: dir,
        keepDatabase: job.options.keepDatabase,
        proxy: seam === "proxy",
        beforeStart: async (db) => void (db && (await this.baseline(job.version.id, db))),
      });
    } catch (err) {
      if (phones.length) (await this.phoneLease()).release(phones);
      // One run that can't start must not take the others down with it.
      const summary: RepSummary = {
        rep: job.rep,
        variant: job.variant.name,
        outcome: "error",
        broken: [],
        error: `could not start the ${this.onPhones() ? "run" : "branch"}: ${(err as Error).message.split("\n")[0]}`,
        durationMs: Date.now() - started,
        diff: "",
      };
      await writeJson(`${dir}/result.json`, summary).catch(() => undefined);
      return summary;
    }

    let rep: Rep | undefined;
    let ruleResults: RuleResult[] = [];
    let outcome: RepOutcome = "error";
    let error: string | undefined;
    let diffSummary = "";
    try {
      rep = new Rep({
        experiment: job.experiment,
        variant: job.variant,
        driver: await this.driver(job.version, phones, branch),
        baseUrl: branch.baseUrl,
        appUrl: branch.appUrl,
        proxy: branch.proxy,
        database: branch.database,
        tenant: branch.payments?.tenant,
        flow: job.flow!,
        login: job.login,
        users: this.testUsers(),
        tabs: tabLabels(job.users),
        dir,
        trace,
        ...(this.onPhones() ? { client: "phone" } : {}),
      });
      await rep.execute();

      const phoneFiles = phoneFilesOf(job.rules);
      const target = {
        database: branch.database,
        ...(phoneFiles.length ? { phones: await rep.phoneData(phoneFiles, dir) } : {}),
        cwd: this.project.root,
        env: {
          DATA_DIR: branch.dataDir,
          BASE_URL: branch.appUrl,
          RUN_DIR: dir,
          ...(this.project.config.app.isolateHome ? { HOME: branch.dataDir } : {}),
        },
      };
      ruleResults = await checkRules(target, job.rules, runFacts(rep.requests, rep.steps, this.testUsers()));
      if (branch.database) {
        const diff = diffSnapshots(await this.baseline(job.version.id, branch.database), await snapshotDatabase(branch.database));
        diffSummary = diff.summary;
        await writeJson(`${dir}/db-diff.json`, diff);
      }

      const broken = ruleResults.filter((r) => !r.ok && !r.error);
      const ruleErrors = ruleResults.filter((r) => r.error);
      error = rep.errors[0]
        ? `${rep.errors[0].tab}${rep.errors[0].step ? ` / ${rep.errors[0].step}` : ""}: ${rep.errors[0].message}`
        : ruleErrors[0]
          ? `rule ${ruleErrors[0].id}: ${ruleErrors[0].error}`
          : undefined;
      outcome = broken.length > 0 ? "broken" : error ? "error" : "ok";
    } catch (err) {
      error = (err as Error).message.split("\n")[0];
    }

    const keepTraces = trace === "on" || (trace === "failures" && outcome !== "ok");
    const traces = rep ? await rep.close(keepTraces).catch(() => []) : [];
    await branch.stop().catch(() => undefined);
    if (phones.length) (await this.phoneLease()).release(phones);

    const warnings = rep?.warnings() ?? [];
    const summary: RepSummary = {
      rep: job.rep,
      variant: job.variant.name,
      outcome,
      broken: ruleResults.filter((r) => !r.ok && !r.error).map((r) => r.id),
      ...(error ? { error } : {}),
      durationMs: Date.now() - started,
      diff: diffSummary,
      ...(warnings.length ? { warnings } : {}),
    };
    await writeJson(`${dir}/result.json`, {
      ...summary,
      startedAt: rep ? new Date(rep.t0).toISOString() : undefined,
      branch: {
        id: branch.id,
        port: branch.port,
        database: branch.database?.kind === "postgres" ? branch.database.name : branch.database?.path,
        dataDir: branch.dataDir,
        kept: !!job.options.keepDatabase,
        ...(branch.proxy ? { seam: "proxy" } : {}),
      },
      rules: ruleResults,
      errors: rep?.errors ?? [],
      timedOut: rep?.timedOut ?? false,
      steps: rep?.steps ?? [],
      race: rep?.race,
      webhooks: (rep?.webhookRecords() ?? []).map((w) => ({ ...w, path: this.project.config.mockPay?.webhookPath })),
      charges: (branch.payments?.tenant.charges ?? []).map((c) => ({
        id: c.id,
        amount: c.amount,
        idempotencyKey: c.idempotency_key,
        metadata: c.metadata,
      })),
      // Each create-charge request (replays too), for the trace.
      chargeCalls: (branch.payments?.tenant.calls ?? []).map((c) => ({ ...c, at: c.at - (rep?.t0 ?? started) })),
      console: rep?.console ?? [],
      traces,
    });
    if (rep) {
      await writeJson(`${dir}/requests.json`, rep.requests);
      for (const r of rep.requests) {
        if (r.sent !== null) job.touched.add(`${r.method} ${r.url.split("?")[0]}`);
      }
      const webhookPath = this.project.config.mockPay?.webhookPath;
      if (webhookPath && rep.webhookRecords().some((w) => w.deliveries.length > 0)) job.touched.add(`POST ${webhookPath}`);
    }
    if (rep && branch.sql) {
      const t0 = rep.t0;
      await writeJson(`${dir}/sql.json`, {
        dropped: branch.sql.dropped,
        statements: branch.sql.records.map((r) => ({ ...r, at: r.at - t0 })),
      });
    }
    return summary;
  }

  /** A Mac app's run: its scenario on a fresh data folder (and SQLite copy), with no server. */
  private async runScenario(job: RepJob): Promise<RepSummary> {
    const started = Date.now();
    const dir = this.store.repDir(job.dir, job.rep);
    await mkdir(dir, { recursive: true });
    const mac = this.project.config.mac!;
    let run: ScenarioRun | undefined;
    let ruleResults: RuleResult[] = [];
    let outcome: RepOutcome = "error";
    let error: string | undefined;
    let diffSummary = "";
    let dataDir: string | undefined;
    try {
      const setup = await this.macSetup(job.version);
      const { tests } = setup;
      const named = job.experiment.scenario!.split("/")[0]!.split(".").slice(0, -1).join(".");
      const hosted = tests.kind === "xcode" ? (tests.hosted.find((h) => h.module === named) ?? tests.hosted[0]) : undefined;
      if (tests.kind === "xcode" && !hosted) throw new Error(`the build of ${mac.project} has no test bundle that runs inside the app`);
      const scenario = await findScenario(setup.cwd, job.experiment.scenario!, undefined, hosted && { module: hosted.module });
      if (!scenario) throw new Error(`no XCTest method ${job.experiment.scenario} in this version's tests`);
      const reports = setup.sanitized ? join(dir, "tsan") : undefined;
      await this.branches.isolated(job.version, { keepDatabase: job.options.keepDatabase }, async (state) => {
        dataDir = state.dataDir;
        if (state.database) await this.baseline(job.version.id, state.database);
        // Foundation finds the home folder from CFFIXED_USER_HOME, not HOME.
        const home: Record<string, string> = this.project.config.app.isolateHome ? { CFFIXED_USER_HOME: state.dataDir } : {};
        const env: Record<string, string> = { ...state.env, ...home };
        for (const [key, value] of Object.entries(mac.env)) env[key] = expandVars(value, { ...process.env, ...env });
        run = new ScenarioRun({
          experiment: job.experiment,
          variant: job.variant,
          ...(hosted ? { host: hosted } : { xctest: setup.xctest!, bundle: (tests as { bundle: string }).bundle }),
          test: scenario.test,
          cwd: setup.cwd,
          env,
          ...(reports ? { sanitizer: { ...(setup.library ? { library: setup.library } : {}), reports } } : {}),
          dir,
        });
        await run.execute();
        const target = {
          database: state.database,
          cwd: this.project.root,
          env: { DATA_DIR: state.dataDir, RUN_DIR: dir, ...(this.project.config.app.isolateHome ? { HOME: state.dataDir } : {}) },
          ...(reports ? { threadSanitizer: reports } : {}),
        };
        ruleResults = await checkRules(target, job.rules, runFacts(run.requests, run.steps, {}));
        if (state.database) {
          const diff = diffSnapshots(await this.baseline(job.version.id, state.database), await snapshotDatabase(state.database));
          diffSummary = diff.summary;
          await writeJson(`${dir}/db-diff.json`, diff);
        }
      });
      const broken = ruleResults.filter((r) => !r.ok && !r.error);
      const ruleErrors = ruleResults.filter((r) => r.error);
      const first = run!.errors[0];
      error = first ? `${first.step ? `${first.step}: ` : ""}${first.message.split("\n")[0]}` : ruleErrors[0] ? `rule ${ruleErrors[0].id}: ${ruleErrors[0].error}` : undefined;
      outcome = broken.length > 0 ? "broken" : error ? "error" : "ok";
    } catch (err) {
      error = (err as Error).message.split("\n")[0];
    }

    const ran = run as ScenarioRun | undefined;
    const warnings = ran?.warnings() ?? [];
    const summary: RepSummary = {
      rep: job.rep,
      variant: job.variant.name,
      outcome,
      broken: ruleResults.filter((r) => !r.ok && !r.error).map((r) => r.id),
      ...(error ? { error } : {}),
      durationMs: Date.now() - started,
      diff: diffSummary,
      ...(warnings.length ? { warnings } : {}),
    };
    await writeJson(`${dir}/result.json`, {
      ...summary,
      startedAt: ran ? new Date(ran.t0).toISOString() : undefined,
      scenario: job.experiment.scenario,
      branch: { dataDir, kept: !!job.options.keepDatabase, seam: "probe" },
      rules: ruleResults,
      errors: ran?.errors ?? [],
      timedOut: ran?.timedOut ?? false,
      steps: ran?.steps ?? [],
      race: ran?.race,
      webhooks: [],
      charges: [],
      chargeCalls: [],
      console: [],
      traces: [],
    });
    if (ran) {
      await writeJson(`${dir}/requests.json`, ran.requests);
      for (const r of ran.requests) if (r.sent !== null) job.touched.add(`${r.method} ${r.url}`);
    }
    return summary;
  }

  /** The version's tests (built on first use), and what starts them, once per version. */
  private macSetup(version: CodeVersion): Promise<MacSetup> {
    let setup = this.macSetups.get(version.id);
    if (!setup) {
      setup = (async () => {
        const mac = this.project.config.mac!;
        const sanitizer = sanitizerOf(mac);
        if (sanitizer === "thread") {
          this.sanitizerChecked ??= threadSanitizerProblem();
          const problem = await this.sanitizerChecked;
          if (problem) {
            throw new ConfigError(`${problem}. Update Xcode, or run without ThreadSanitizer: mac.sanitizer: none in ${CONFIG_FILE}, or WINDTUNNEL_SANITIZER=none`);
          }
        }
        const prepared = await this.branches.prepare(version);
        const cwd = join(prepared.worktree, this.project.appSubdir, mac.dir);
        if (mac.project) {
          // The tests run inside the app: without the hook, each run would start the app itself, on screen.
          if (!(await scenarioHost(cwd))) {
            throw new ConfigError(
              `${mac.project}: the app never calls Probe.hostScenario(). An Xcode project's scenarios run inside its app; call it first thing in the app's entry point, so a run starts the scenario instead of the app (swift/WindTunnelProbe/README.md)`,
            );
          }
          const tests = await this.branches.versions.macTests(prepared, sanitizer);
          return { tests, cwd, sanitized: sanitizer === "thread" };
        }
        const xctest = (await runScript("xcrun --find xctest", { cwd: this.project.root, timeoutMs: 30_000 })).stdout.trim();
        if (!xctest) throw new ConfigError("xctest not found: install Xcode (the Command Line Tools alone have no XCTest)");
        const library = sanitizer === "thread" ? await threadSanitizerLibrary() : undefined;
        if (sanitizer === "thread" && !library) throw new ConfigError("ThreadSanitizer's runtime is not in the active Xcode toolchain");
        const tests = await this.branches.versions.macTests(prepared, sanitizer);
        return { xctest, tests, cwd, ...(library ? { library } : {}), sanitized: sanitizer === "thread" };
      })();
      this.macSetups.set(version.id, setup);
      setup.catch(() => this.macSetups.delete(version.id));
    }
    return setup;
  }

  private testUsers(): Record<string, TestUser> {
    return Object.fromEntries(
      Object.entries(this.project.config.users).map(([name, u]) => [name, { name, email: u.email, password: u.password }]),
    );
  }

  /** The seed state of a version, read from the first fresh database copy. */
  private baseline(versionId: string, db: Database): Promise<DbSnapshot> {
    let snapshot = this.baselines.get(versionId);
    if (!snapshot) {
      snapshot = snapshotDatabase(db);
      this.baselines.set(versionId, snapshot);
    }
    return snapshot;
  }

  /** Whether the app runs on phones (emulators or simulators), which reach the server through the proxy. */
  private onPhones(): boolean {
    return !!(this.project.config.android || this.project.config.ios);
  }

  private async phoneLease(): Promise<PhoneLease> {
    return this.project.config.ios ? (await this.iosRuntime()).simulators : (await this.androidRuntime()).emulators;
  }

  /** A browser for web and Tauri apps; the run's phones for Android and iOS apps. */
  private async driver(version: CodeVersion, phones: string[], branch: Branch): Promise<Driver> {
    const { android, ios } = this.project.config;
    if (ios) {
      const runtime = await this.iosRuntime();
      const { phoneApp } = await this.branches.prepare(version);
      return new IosDriver({
        phones,
        app: { bundleId: ios.bundleId, app: phoneApp!, arguments: ios.arguments, env: ios.env },
        proxy: branch.proxy!,
        agent: (udid) => this.agent(runtime, udid),
      });
    }
    if (!android) return new PlaywrightDriver(await this.launch());
    const { sdk, emulators, appium } = await this.androidRuntime();
    const { phoneApp } = await this.branches.prepare(version);
    for (const phone of phones) await emulators.install(phone, phoneApp!, android.package);
    return new AndroidDriver({
      sdk,
      appium,
      phones,
      app: { package: android.package, activity: android.activity, apk: phoneApp!, extras: android.extras },
      proxy: branch.proxy!,
    });
  }

  private iosRuntime(): Promise<IosRuntime> {
    this.ios ??= (async () => {
      const source = await findWebDriverAgentSource(this.project.root);
      if (!source) throw new ConfigError("WebDriverAgent is not installed: `npm i -D appium-webdriveragent` in the project (see `windtunnel doctor`)");
      const logs = join(this.project.stateDir, "logs", "devices");
      const wda = await buildWebDriverAgent(source, join(this.project.cacheDir, "wda"), join(logs, "wda-build.log"));
      return { simulators: new Simulators({ max: this.project.config.ios!.devices }), wda, agents: new Map() };
    })();
    return this.ios;
  }

  /** WebDriverAgent on a simulator, reading the app's screen. */
  private agent(runtime: IosRuntime, udid: string): Promise<WebDriverAgent> {
    let agent = runtime.agents.get(udid);
    if (!agent) {
      agent = (async () => {
        const started = await WebDriverAgent.start(runtime.wda, {
          udid,
          dir: join(this.project.cacheDir, "wda", "runs"),
          logFile: join(this.project.stateDir, "logs", "devices", `wda-${udid}.log`),
        });
        await started.open(this.project.config.ios!.bundleId);
        return started;
      })();
      runtime.agents.set(udid, agent);
      agent.catch(() => runtime.agents.delete(udid));
    }
    return agent;
  }

  private androidRuntime(): Promise<AndroidRuntime> {
    this.android ??= (async () => {
      const sdk = await findAndroidSdk();
      if (!sdk) throw new ConfigError("no Android SDK found: set ANDROID_HOME, or install Android Studio");
      const { avd, devices } = this.project.config.android!;
      const logs = join(this.project.stateDir, "logs", "devices");
      const emulators = new Emulators(sdk, { avd, max: devices, logDir: logs });
      const appium = await Appium.start({
        from: this.project.root,
        driver: "appium-uiautomator2-driver",
        env: { ANDROID_HOME: sdk.root, ANDROID_SDK_ROOT: sdk.root },
        logFile: join(logs, "appium.log"),
      });
      return { sdk, emulators, appium };
    })();
    return this.android;
  }

  private launch(): Promise<Browser> {
    this.browser ??= browserFor(this.project.config.app.kind).type.launch({ headless: !this.headed });
    return this.browser;
  }
}

/** One repetition of an experiment, as the runner hands it out. */
interface RepJob {
  experiment: Experiment;
  variant: Variant;
  version: CodeVersion;
  rules: Rule[];
  /** Absent for a Mac app's scenario. */
  flow?: LoadedFlow;
  login?: LoadedFlow;
  users: string[];
  rep: number;
  dir: string;
  options: RunOptions;
  touched: Set<string>;
}

/** Whether a Mac app's build has ThreadSanitizer: $WINDTUNNEL_SANITIZER, else `mac.sanitizer`. */
export function sanitizerOf(mac: MacConfig): Sanitizer {
  const value = process.env.WINDTUNNEL_SANITIZER;
  if (value === undefined || value === "") return mac.sanitizer;
  if (value === "thread" || value === "none") return value;
  throw new ConfigError(`WINDTUNNEL_SANITIZER=${value}: use thread or none`);
}

function seamFromEnv(): Seam {
  const value = process.env.WINDTUNNEL_SEAM;
  if (value === undefined || value === "" || value === "route") return "route";
  if (value === "proxy") return "proxy";
  throw new ConfigError(`WINDTUNNEL_SEAM=${value}: use route or proxy`);
}

function summarizeVariant(name: string, reps: RepSummary[]): VariantResult {
  const runs = reps.filter((r) => r.variant === name);
  const ok = runs.filter((r) => r.outcome === "ok").length;
  const broken = runs.filter((r) => r.outcome === "broken").length;
  const errors = runs.filter((r) => r.outcome === "error").length;
  const rules: Record<string, number> = {};
  for (const r of runs) for (const id of r.broken) rules[id] = (rules[id] ?? 0) + 1;
  const outcome: Outcome =
    ok === runs.length ? "pass" : broken === runs.length ? "fail" : errors === runs.length ? "error" : "flaky";
  const firstError = runs.find((r) => r.error);
  return {
    variant: name,
    runs: runs.length,
    ok,
    broken,
    errors,
    outcome,
    flakeRate: runs.length ? round(1 - Math.max(ok, broken, errors) / runs.length) : 0,
    rules,
    ...(broken ? { firstBroken: runs.find((r) => r.outcome === "broken")!.rep } : {}),
    ...(firstError ? { firstError: { rep: firstError.rep, message: firstError.error! } } : {}),
  };
}

const SEVERITY: Outcome[] = ["pass", "error", "flaky", "fail"];

function worst(outcomes: Outcome[]): Outcome {
  return outcomes.reduce<Outcome>((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), "pass");
}

export function headline(result: ExperimentResult): string {
  const runs = result.reps.length;
  const rules = new Map<string, number>();
  for (const v of result.variants) for (const [id, n] of Object.entries(v.rules)) rules.set(id, (rules.get(id) ?? 0) + n);
  const broken = [...rules].map(([id, n]) => `${id} ${n}/${runs}`).join(", ");
  const errors = result.reps.filter((r) => r.outcome === "error").length;
  return [result.outcome, broken, errors ? `${errors}/${runs} errored` : ""].filter(Boolean).join(" · ");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

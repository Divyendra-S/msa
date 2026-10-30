import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";
import { type Branch, Branches } from "../branches/branches.ts";
import { browserFor } from "../browser.ts";
import type { CodeVersion, CodeVersionSpec } from "../branches/code-versions.ts";
import { ConfigError } from "../config.ts";
import type { Database } from "../database.ts";
import { CommandError, sh } from "../exec.ts";
import type { TestUser } from "../flow-api.ts";
import { checkRules, loadRules, type Rule, type RuleResult } from "../rules.ts";
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

/** Runs experiments: each repetition in its own branch, all at once up to `parallel`. */
export class Runner {
  readonly branches: Branches;
  readonly store: RunStore;
  private browser?: Promise<Browser>;
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
    if (kind !== "web" && kind !== "tauri") {
      throw new ConfigError(`app.kind ${kind}: only web and Tauri apps can run experiments so far (the plan for ${kind} apps is in platforms-plan.md)`);
    }
    const rules = await loadRules(this.project);
    const problems: string[] = [];
    const warnings: string[] = [];
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
    options = { ...options, seam: options.seam ?? seamFromEnv() };
    const spec = options.version ?? {};
    const version = "tree" in spec ? spec : await this.branches.versions.resolve(spec);
    await this.branches.prepare(version);
    this.pruned ??= this.store.prune();
    await this.pruned;
    this.headed = !!options.headed;
    return Promise.all(experiments.map((experiment) => this.runExperiment(experiment, version, rules, options)));
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
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
    const flow = await loadFlow(this.project.stateDir, experiment.flow);
    const login = (await findFlowFile(this.project.stateDir, LOGIN_FLOW))
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

  private async runRep(job: {
    experiment: Experiment;
    variant: Variant;
    version: CodeVersion;
    rules: Rule[];
    flow: LoadedFlow;
    login?: LoadedFlow;
    users: string[];
    rep: number;
    dir: string;
    options: RunOptions;
    touched: Set<string>;
  }): Promise<RepSummary> {
    const started = Date.now();
    const dir = this.store.repDir(job.dir, job.rep);
    await mkdir(dir, { recursive: true });
    const trace = job.options.trace ?? "failures";
    const seam = job.options.seam ?? "route";
    let branch: Branch;
    try {
      branch = await this.branches.create(job.version, {
        logDir: dir,
        keepDatabase: job.options.keepDatabase,
        proxy: seam === "proxy",
        beforeStart: async (db) => void (db && (await this.baseline(job.version.id, db))),
      });
    } catch (err) {
      // One run that can't start must not take the others down with it.
      const summary: RepSummary = {
        rep: job.rep,
        variant: job.variant.name,
        outcome: "error",
        broken: [],
        error: `could not start the branch: ${(err as Error).message.split("\n")[0]}`,
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
        driver: new PlaywrightDriver(await this.launch()),
        baseUrl: branch.baseUrl,
        appUrl: branch.appUrl,
        proxy: branch.proxy,
        database: branch.database,
        tenant: branch.payments?.tenant,
        flow: job.flow,
        login: job.login,
        users: this.testUsers(),
        tabs: tabLabels(job.users),
        dir,
        trace,
      });
      await rep.execute();

      const target = {
        database: branch.database,
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

  private launch(): Promise<Browser> {
    this.browser ??= browserFor(this.project.config.app.kind).type.launch({ headless: !this.headed });
    return this.browser;
  }
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

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CodeVersion, CodeVersionSpec } from "../branches/code-versions.ts";
import { ConfigError } from "../config.ts";
import { loadRules } from "../rules.ts";
import type { Experiment } from "./experiment.ts";
import { experimentInputs } from "./inputs.ts";
import type { ExperimentResult, Outcome, Runner } from "./runner.ts";
import { writeJson } from "./store.ts";

/**
 * regressed: holds on the base, not on the change · new: doesn't hold on the change, and can't run
 * on the base (what it needs came with the change) · broken: doesn't hold on either (or nothing
 * changed) · fixed: broke on the base, holds on the change · holds: holds on the change.
 */
export type CheckVerdict = "regressed" | "new" | "broken" | "fixed" | "holds";

export interface CheckSide {
  outcome: Outcome;
  runId: string;
  /** Rules broken, each with the runs it broke in: `saved-project-is-latest 3/9`. */
  broken: string[];
  reps: number;
  /** Runs that broke a rule or couldn't finish, and those that couldn't finish. */
  failed: number;
  errors: number;
  /** The first run's error, when one couldn't finish. */
  error?: string;
  /** Taken from an earlier run of exactly this code and experiment. */
  reused?: boolean;
}

export interface CheckEntry {
  experiment: string;
  description?: string;
  /** Its flow, or a Swift app's scenario. */
  flow?: string;
  verdict: CheckVerdict;
  change: CheckSide;
  /** Run where the change doesn't hold; otherwise only an earlier run on record, if there is one. */
  base?: CheckSide;
  /** Why it couldn't run on the base at all (the base can't be built, or lacks the scenario's host). */
  baseError?: string;
  finding?: Experiment["finding"];
}

export interface CheckResult {
  id: string;
  at: string;
  base: CodeVersion;
  change: CodeVersion;
  /** The base has the same code as the change: nothing could have regressed. */
  same: boolean;
  entries: CheckEntry[];
  counts: Record<CheckVerdict, number>;
}

export interface CheckOptions {
  experiments: Experiment[];
  /** The code to compare with (default: HEAD). */
  base?: CodeVersionSpec;
  /** The change (default: the working tree). */
  change?: CodeVersionSpec;
  /** Overrides each experiment's `repeat`. */
  repeat?: number;
  /** Run on the change even where a result on exactly this code is on record. */
  fresh?: boolean;
  onProgress?: (message: string) => void;
}

const CHECKS_DIR = "checks";

/**
 * A pull request's check, before there is one: every experiment on the change, and where one
 * doesn't hold, the same experiment on the base, to tell what the change broke from what was
 * broken already. Results on record for exactly the same code and experiment are reused.
 */
export async function check(runner: Runner, options: CheckOptions): Promise<CheckResult> {
  if (options.experiments.length === 0) throw new ConfigError("no experiments to check");
  const versions = runner.branches.versions;
  const base = await versions.resolve(options.base ?? { ref: "HEAD" });
  const change = await versions.resolve(options.change ?? {});
  const same = base.id === change.id;
  const rules = await loadRules(runner.project);
  const index = await runner.store.list(Number.MAX_SAFE_INTEGER);
  const progress = options.onProgress ?? (() => undefined);

  // The newest finished result of this experiment, with these inputs, on this code, with enough runs.
  const onRecord = async (e: Experiment, tree: string): Promise<ExperimentResult | undefined> => {
    const inputs = await experimentInputs(runner.project, e, rules);
    const repeat = options.repeat ?? e.repeat;
    for (const entry of index) {
      if (entry.experiment !== e.id || entry.outcome === "error" || entry.outcome === "running") continue;
      const r = (await runner.store.read(entry.id).catch(() => undefined)) as ExperimentResult | undefined;
      if (r?.version.tree !== tree || r.inputs !== inputs) continue;
      if (Math.min(...r.variants.map((v) => v.runs)) < repeat) continue;
      return r;
    }
    return undefined;
  };
  const runOn = async (version: CodeVersion, experiments: Experiment[], into: Map<string, CheckSide>) => {
    if (experiments.length === 0) return;
    progress(`running ${experiments.length} experiment(s) on ${version.label}`);
    for (const r of await runner.run(experiments, { version, repeat: options.repeat })) into.set(r.experiment, side(r));
  };

  const changed = new Map<string, CheckSide>();
  const missing: Experiment[] = [];
  for (const e of options.experiments) {
    const r = options.fresh ? undefined : await onRecord(e, change.tree);
    if (r) changed.set(e.id, side(r, true));
    else missing.push(e);
  }
  await runOn(change, missing, changed);

  // The base only where it tells something: a failure's cause, or (from the record) a fix. A base
  // that can't run at all leaves its experiments new with the change.
  const based = new Map<string, CheckSide>();
  let baseError: string | undefined;
  if (!same) {
    const needed: Experiment[] = [];
    for (const e of options.experiments) {
      const r = await onRecord(e, base.tree);
      if (r) based.set(e.id, side(r, true));
      else if (changed.get(e.id)!.outcome !== "pass") needed.push(e);
    }
    try {
      await runOn(base, needed, based);
    } catch (err) {
      baseError = (err as Error).message;
      progress(`can't run on ${base.label}: ${baseError}`);
    }
  }

  const entries = options.experiments.map((e): CheckEntry => {
    const c = changed.get(e.id)!;
    const b = based.get(e.id);
    const missed = !same && c.outcome !== "pass" && !b && baseError ? baseError : undefined;
    const verdict: CheckVerdict =
      c.outcome === "pass" ? (b && (b.outcome === "fail" || b.outcome === "flaky") ? "fixed" : "holds")
      : same ? "broken"
      : b?.outcome === "pass" ? "regressed"
      : missed || b?.outcome === "error" ? "new"
      : "broken";
    return {
      experiment: e.id,
      ...(e.description ? { description: e.description } : {}),
      ...((e.flow ?? e.scenario) ? { flow: e.flow ?? e.scenario } : {}),
      verdict,
      change: c,
      ...(b ? { base: b } : {}),
      ...(missed ? { baseError: missed } : {}),
      ...(e.finding && verdict !== "holds" ? { finding: e.finding } : {}),
    };
  });
  const order: CheckVerdict[] = ["regressed", "new", "broken", "fixed", "holds"];
  entries.sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict) || a.experiment.localeCompare(b.experiment));
  const at = new Date().toISOString();
  const result: CheckResult = {
    id: at.replace(/[-:T]/g, "").slice(2, 14),
    at,
    base,
    change,
    same,
    entries,
    counts: Object.fromEntries(order.map((v) => [v, entries.filter((x) => x.verdict === v).length])) as Record<CheckVerdict, number>,
  };
  const dir = join(runner.project.stateDir, CHECKS_DIR);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, `${result.id}.json`), result);
  await writeJson(join(dir, "latest.json"), result);
  return result;
}

/** The newest check (`.windtunnel/checks/latest.json`), if there was one. */
export function latestCheckPath(stateDir: string): string {
  return join(stateDir, CHECKS_DIR, "latest.json");
}

function side(r: ExperimentResult, reused = false): CheckSide {
  const rules = new Map<string, number>();
  for (const rep of r.reps) for (const id of rep.broken) rules.set(id, (rules.get(id) ?? 0) + 1);
  const error = r.reps.find((x) => x.outcome === "error")?.error;
  return {
    outcome: r.outcome,
    runId: r.runId,
    broken: [...rules].map(([id, n]) => `${id} ${n}/${r.reps.length}`),
    reps: r.reps.length,
    failed: r.reps.filter((x) => x.outcome !== "ok").length,
    errors: r.reps.filter((x) => x.outcome === "error").length,
    ...(error ? { error } : {}),
    ...(reused ? { reused } : {}),
  };
}

const WORDS: Record<CheckVerdict, string> = { regressed: "REGRESSED", new: "NEW", broken: "BROKEN", fixed: "FIXED", holds: "holds" };

/** For a terminal, or an agent about to open a pull request. */
export function formatCheck(result: CheckResult): string {
  const code = (v: CodeVersion) => `${v.label}${v.base && v.label !== "working tree" ? ` @ ${v.base.slice(0, 12)}` : ""}`;
  const lines = [
    result.same
      ? `Check: ${code(result.change)} has the same code as ${code(result.base)}, so nothing could regress`
      : `Check: ${code(result.change)} against ${code(result.base)}`,
  ];
  const width = Math.max(...result.entries.map((e) => e.experiment.length));
  for (const e of result.entries.filter((x) => x.verdict !== "holds")) {
    lines.push(`  ${WORDS[e.verdict].padEnd(9)}  ${e.experiment.padEnd(width)}  ${what(e.change)}${baseNote(e, result)}  run ${e.change.runId}`);
    if (e.finding && e.verdict !== "fixed") lines.push(`             ${" ".repeat(width)}  cause: ${firstSentence(e.finding.cause)}`);
  }
  const why = result.entries.find((x) => x.baseError)?.baseError;
  if (why) lines.push(`  (${result.base.label} can't run them: ${why})`);
  const holding = result.entries.filter((x) => x.verdict === "holds");
  if (holding.length) lines.push(`  holds      ${holding.map((x) => x.experiment).join(", ")}`);
  const { regressed, new: added, broken, fixed } = result.counts;
  lines.push(
    `Verdict: ${regressed ? `${regressed} regression${regressed > 1 ? "s" : ""}` : "nothing regressed"}` +
      `${added ? ` · ${added} new, not on ${result.base.label}` : ""}${broken ? ` · ${broken} already broken` : ""}${fixed ? ` · ${fixed} fixed` : ""}`,
  );
  return lines.join("\n");
}

/** One comment for a pull request: what the change broke first, with why and where. */
export function formatCheckMarkdown(result: CheckResult): string {
  const { regressed, new: added, broken, fixed } = result.counts;
  const failing = added + broken;
  const title = regressed
    ? `❌ **${regressed} regression${regressed > 1 ? "s" : ""}**: experiments that hold on \`${result.base.label}\` don't hold with this change.`
    : failing
      ? `⚠️ **Nothing regressed** against \`${result.base.label}\`, but ${failing} experiment${failing > 1 ? "s don't" : " doesn't"} hold.`
      : `✅ **Nothing regressed** against \`${result.base.label}\`.`;
  const lines = [title, "", "| | Experiment | This change | Base |", "|---|---|---|---|"];
  const icon: Record<CheckVerdict, string> = { regressed: "❌", new: "🆕", broken: "⚠️", fixed: "✅", holds: "✓" };
  for (const e of result.entries) {
    const base = e.base ? (e.base.outcome === "pass" ? "holds" : what(e.base)) : e.baseError ? "can't run" : "–";
    lines.push(`| ${icon[e.verdict]} ${e.verdict} | \`${e.experiment}\` | ${e.change.outcome === "pass" ? "holds" : what(e.change)} | ${base} |`);
  }
  for (const e of result.entries.filter((x) => x.finding && x.verdict !== "fixed" && x.verdict !== "holds")) {
    lines.push("", `### \`${e.experiment}\``, ...(e.description ? ["", e.description] : []), "", `**Why:** ${e.finding!.cause}`);
    if (e.finding!.fix) lines.push("", `**Fix:** ${e.finding!.fix}`);
    if (e.finding!.code.length) lines.push("", `**Where:** ${e.finding!.code.map((c) => `\`${c}\``).join(", ")}`);
  }
  const notes = [
    added ? `${added} new with this change (they can't run on the base)` : "",
    broken ? `${broken} already broken on the base` : "",
    fixed ? `${fixed} fixed by this change` : "",
  ].filter(Boolean);
  if (notes.length) lines.push("", `${notes.join(" · ")}.`);
  lines.push("", `<sub>Reproduce: \`windtunnel run <experiment>\` · watch it: \`windtunnel view\`</sub>`);
  return lines.join("\n");
}

function firstSentence(text: string): string {
  const end = /[.!?](\s|$)/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

function what(s: CheckSide): string {
  if (s.outcome === "pass") return `held ${s.reps}/${s.reps}`;
  const parts = [...s.broken, ...(s.errors ? [`couldn't finish ${s.errors}/${s.reps}`] : [])];
  return parts.join(", ") || s.outcome;
}

function baseNote(e: CheckEntry, result: CheckResult): string {
  if (e.verdict === "new") return ` · can't run on ${result.base.label}`;
  if (result.same || !e.base) return "";
  if (e.verdict === "regressed") return ` · holds on ${result.base.label}`;
  if (e.verdict === "fixed") return ` · broke on ${result.base.label}`;
  return e.base.outcome === "error" ? ` · couldn't run on ${result.base.label}` : ` · broken on ${result.base.label} too`;
}

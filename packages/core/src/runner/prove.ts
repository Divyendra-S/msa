import type { CodeVersion, CodeVersionSpec } from "../branches/code-versions.ts";
import { ConfigError } from "../config.ts";
import type { Experiment } from "./experiment.ts";
import type { ExperimentResult, Runner } from "./runner.ts";

export interface ProveOptions {
  /** Experiments that reproduce the bug: they must fail on `base` and pass on `fix`. */
  experiments: Experiment[];
  /** Code with the bug (default: HEAD; `{}` is the working tree). */
  base?: CodeVersionSpec;
  /** Code with the fix (default: the working tree). */
  fix?: CodeVersionSpec;
  /** Runs per ordering (default: each experiment's `repeat`, at least 5). */
  repeat?: number;
  /** Experiments that must not get worse (default: every other experiment). */
  regression?: Experiment[];
}

export interface RegressionResult {
  experiment: string;
  base: ExperimentResult["outcome"];
  fix: ExperimentResult["outcome"];
  runId: string;
}

export interface ProofResult {
  verdict: "proven" | "not proven";
  /** Why the proof failed (empty when proven). */
  reasons: string[];
  base: { version: CodeVersion; results: ExperimentResult[] };
  fix: { version: CodeVersion; results: ExperimentResult[] };
  /** The base code run again after the fix passed: it must fail again. */
  revert: ExperimentResult[];
  regression: RegressionResult[];
  repeat: number;
}

/**
 * A fix is proven when its experiments fail on the base code every time, pass on the fix
 * every time in every ordering, fail again on the base code, and no other experiment that
 * passed on the base code fails on the fix.
 */
export async function prove(runner: Runner, options: ProveOptions): Promise<ProofResult> {
  if (options.experiments.length === 0) throw new ConfigError("prove needs at least one experiment that reproduces the bug");
  const versions = runner.branches.versions;
  const base = await versions.resolve(options.base ?? { ref: "HEAD" });
  const fix = await versions.resolve(options.fix ?? {});
  if (base.id === fix.id) {
    throw new ConfigError(`the fix (${fix.label}) has the same code as the base (${base.label}): nothing to prove`);
  }
  const repeat = options.repeat ?? Math.max(5, ...options.experiments.map((e) => e.repeat));
  const targets = new Set(options.experiments.map((e) => e.id));
  const regression = (options.regression ?? []).filter((e) => !targets.has(e.id));

  const run = (version: CodeVersion, experiments: Experiment[], n?: number) =>
    experiments.length ? runner.run(experiments, { version, repeat: n }) : Promise.resolve([]);
  const [baseResults, fixResults, baseRegression, fixRegression] = await Promise.all([
    run(base, options.experiments, repeat),
    run(fix, options.experiments, repeat),
    run(base, regression),
    run(fix, regression),
  ]);
  // Only after the fix passed: the bug must come back without it.
  const revert = await run(base, options.experiments, repeat);

  const reasons: string[] = [];
  for (const r of baseResults) {
    if (r.outcome !== "fail") reasons.push(`${r.experiment} does not reproduce the bug on the base code (${r.outcome}; run ${r.runId})`);
  }
  for (const r of fixResults) {
    if (r.outcome !== "pass") {
      const bad = r.variants.filter((v) => v.outcome !== "pass").map((v) => `${v.variant === "default" ? "" : `${v.variant}: `}${v.outcome} ${v.ok}/${v.runs} ok`);
      reasons.push(`${r.experiment} still fails with the fix (${bad.join(", ")}; run ${r.runId})`);
    }
  }
  for (const r of revert) {
    if (r.outcome !== "fail") reasons.push(`${r.experiment} did not fail again on the base code (${r.outcome}; run ${r.runId}): the result may be flaky`);
  }
  // A rule that can't run says nothing either way: the proof isn't valid until it does.
  for (const [stage, results] of [["base", baseResults], ["fix", fixResults], ["revert", revert]] as const) {
    for (const r of results) {
      const rep = r.reps.find((x) => x.error?.startsWith("rule "));
      if (rep) reasons.push(`${r.experiment} on the ${stage}: ${rep.error} (run ${r.runId})`);
    }
  }
  const regressions: RegressionResult[] = fixRegression.map((f) => {
    const b = baseRegression.find((x) => x.experiment === f.experiment)!;
    return { experiment: f.experiment, base: b.outcome, fix: f.outcome, runId: f.runId };
  });
  for (const r of regressions) {
    if (r.base === "pass" && r.fix !== "pass") reasons.push(`regression: ${r.experiment} passes on the base code but is ${r.fix} with the fix (run ${r.runId})`);
  }

  return {
    verdict: reasons.length === 0 ? "proven" : "not proven",
    reasons,
    base: { version: base, results: baseResults },
    fix: { version: fix, results: fixResults },
    revert,
    regression: regressions,
    repeat,
  };
}

export function formatProof(proof: ProofResult): string {
  const row = (stage: string, r: ExperimentResult) => {
    const rules = new Map<string, number>();
    for (const rep of r.reps) for (const id of rep.broken) rules.set(id, (rules.get(id) ?? 0) + 1);
    const detail = r.outcome === "pass" ? `${r.reps.length}/${r.reps.length} ok` : [...rules].map(([id, n]) => `${id} ${n}/${r.reps.length}`).join(", ") || `${r.reps.filter((x) => x.outcome === "error").length}/${r.reps.length} errored`;
    return `  ${stage.padEnd(7)} ${r.outcome.toUpperCase().padEnd(6)} ${detail.padEnd(40)} run ${r.runId}`;
  };
  const lines = [
    `Proof: base ${proof.base.version.id} (${proof.base.version.label}) → fix ${proof.fix.version.id} (${proof.fix.version.label}), ${proof.repeat} runs per ordering`,
  ];
  for (const r of proof.base.results) {
    const variants = r.variants.length > 1 ? ` (${r.variants.length} orderings)` : "";
    lines.push(`${r.experiment}${variants}`, row("base", r));
    const f = proof.fix.results.find((x) => x.experiment === r.experiment);
    if (f) lines.push(row("fix", f));
    const v = proof.revert.find((x) => x.experiment === r.experiment);
    if (v) lines.push(row("revert", v));
  }
  if (proof.regression.length) {
    const worse = proof.regression.filter((r) => r.base === "pass" && r.fix !== "pass");
    const already = proof.regression.filter((r) => r.base !== "pass");
    lines.push(
      `Regression set: ${proof.regression.length} other experiment(s) on the fix — ${worse.length ? `${worse.length} got worse: ${worse.map((r) => `${r.experiment} (${r.fix}, run ${r.runId})`).join(", ")}` : "none got worse"}`,
      ...(already.length ? [`  already failing on the base code: ${already.map((r) => `${r.experiment} ${r.base}→${r.fix}`).join(", ")}`] : []),
    );
  }
  lines.push(`Verdict: ${proof.verdict.toUpperCase()}`, ...proof.reasons.map((r) => `  - ${r}`));
  return lines.join("\n");
}

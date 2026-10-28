import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeVersion, CodeVersionSpec } from "../branches/code-versions.ts";
import { ConfigError } from "../config.ts";
import { loadRules } from "../rules.ts";
import { experimentInputs } from "./inputs.ts";
import { writeJson } from "./store.ts";
import type { Experiment } from "./experiment.ts";
import type { ExperimentResult, Runner, TestRun } from "./runner.ts";

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
  /** Run the project's test command (`app.test`) on the base and the fix (default: when configured). */
  tests?: boolean;
  /** Return the last proof of exactly this (same code, experiments, rules, repeat) instead of running again. */
  reuse?: boolean;
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
  /** The project's tests on the base and the fix, when configured. */
  tests?: { base: TestRun; fix: TestRun };
  repeat: number;
  /** Set when this is an earlier proof of the same thing, returned by `reuse`. */
  reused?: string;
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

  // Same code, experiments, rules and settings: the same proof.
  const rules = await loadRules(runner.project);
  const key = createHash("sha256");
  key.update(JSON.stringify([base.tree, fix.tree, repeat, options.tests !== false]));
  for (const e of [...options.experiments, ...regression]) key.update(`${e.id}:${await experimentInputs(runner.project, e, rules)}:${targets.has(e.id)}`);
  const saved = join(runner.project.stateDir, "cache", "proofs", `${key.digest("hex").slice(0, 16)}.json`);
  if (options.reuse) {
    const previous = await readFile(saved, "utf8").then((t) => JSON.parse(t) as ProofResult, () => undefined);
    if (previous) return { ...previous, reused: saved };
  }

  const run = (version: CodeVersion, experiments: Experiment[], n?: number) =>
    experiments.length ? runner.run(experiments, { version, repeat: n }) : Promise.resolve([]);
  // The test suites run one after the other (they may share ports or files), alongside the experiments.
  const testing = options.tests === false ? Promise.resolve(undefined) : (async () => {
    const b = await runner.runTests(base);
    const f = b && (await runner.runTests(fix));
    return b && f ? { base: b, fix: f } : undefined;
  })();
  const [baseResults, fixResults, baseRegression, fixRegression, tests] = await Promise.all([
    run(base, options.experiments, repeat),
    run(fix, options.experiments, repeat),
    run(base, regression),
    run(fix, regression),
    testing,
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
  if (tests?.base.ok && !tests.fix.ok) {
    reasons.push(`regression: the project's tests (${tests.fix.command}) pass on the base code but fail with the fix (exit ${tests.fix.exitCode}; log ${tests.fix.log})`);
  }

  const proof: ProofResult = {
    verdict: reasons.length === 0 ? "proven" : "not proven",
    reasons,
    base: { version: base, results: baseResults },
    fix: { version: fix, results: fixResults },
    revert,
    regression: regressions,
    ...(tests ? { tests } : {}),
    repeat,
  };
  await mkdir(join(runner.project.stateDir, "cache", "proofs"), { recursive: true });
  await writeJson(saved, proof);
  return proof;
}

export function formatProof(proof: ProofResult): string {
  const row = (stage: string, r: ExperimentResult) => {
    const errors = r.reps.filter((x) => x.outcome === "error").length;
    let detail: string;
    if (r.outcome === "pass") detail = `${r.reps.length}/${r.reps.length} ok${r.variants.length > 1 ? " (every ordering)" : ""}`;
    else {
      const rules = [...new Set(r.variants.flatMap((v) => Object.keys(v.rules)))];
      // With several orderings, say which ones broke: "together 3/3 · alice,bob 0/3".
      detail = rules
        .map((id) => (r.variants.length > 1 ? `${id}: ${r.variants.map((v) => `${v.variant} ${v.rules[id] ?? 0}/${v.runs}`).join(" · ")}` : `${id} ${r.variants[0]!.rules[id]}/${r.variants[0]!.runs}`))
        .join("; ");
      if (errors) detail = [detail, `${errors}/${r.reps.length} errored`].filter(Boolean).join("; ");
    }
    return `  ${stage.padEnd(7)} ${r.outcome.toUpperCase().padEnd(6)} ${detail.padEnd(40)} run ${r.runId}`;
  };
  const code = (v: CodeVersion) => `${v.label}${v.base ? ` @ ${v.base.slice(0, 12)}` : ""} (version ${v.id})`;
  const lines = [
    `Proof: base ${code(proof.base.version)} → fix ${code(proof.fix.version)}, ${proof.repeat} runs per ordering`,
    ...(proof.reused ? ["(the same proof as before: nothing changed since, so it was not run again)"] : []),
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
    const both = proof.regression.length - worse.length - already.length;
    lines.push(
      `Regression set: ${proof.regression.length} other experiment(s): ${both} pass on base and fix${worse.length ? `; got worse: ${worse.map((r) => `${r.experiment} (${r.fix}, run ${r.runId})`).join(", ")}` : ""}`,
      ...(already.length ? [`  already not passing on the base code: ${already.map((r) => `${r.experiment} ${r.base}→${r.fix}`).join(", ")}`] : []),
    );
  }
  if (proof.tests) {
    const t = proof.tests;
    const show = (x: TestRun) => `${x.ok ? "pass" : `fail (exit ${x.exitCode})`} in ${(x.durationMs / 1000).toFixed(1)} s`;
    lines.push(`Project tests (${t.base.command}): base ${show(t.base)} · fix ${show(t.fix)}`);
    if (!t.fix.ok) lines.push(...t.fix.tail.slice(-6).map((l) => `  | ${l}`), `  log: ${t.fix.log}`);
  }
  lines.push(`Verdict: ${proof.verdict.toUpperCase()}`, ...proof.reasons.map((r) => `  - ${r}`));
  return lines.join("\n");
}

// Verifies the Bug Zoo end to end: an app's experiments (zoo/shop/.windtunnel) run against the
// clean app, every case variant and every clean control, each run in its own branch.
//
//   pnpm zoo:verify [--repeat 3] [--case 02-lost-response-retry] [--experiment checkout-double-submit]
//   pnpm zoo:verify --app notes      the Tauri notes app (zoo/notes), its cases in zoo/notes/cases
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type CodeVersion,
  type Experiment,
  type ExperimentResult,
  loadExperiments,
  Runner,
  stopOnSignals,
} from "@windtunnel/core";
import { parse as parseYaml } from "yaml";

interface Case {
  id: string;
  title: string;
  /** A clean control (`control.patch`): every experiment must pass, like on the clean shop. */
  control?: boolean;
  experiment?: string;
  /** Only this race ordering must break (default: every run of the experiment). */
  variant?: string;
  breaks: string[];
  handler?: string;
  patch: string;
}

interface Variant {
  id: string;
  version: CodeVersion;
  expected?: Case;
  /** Must pass every experiment: the clean shop and the controls. */
  clean: boolean;
}

async function loadCases(dir: string, only?: string): Promise<Case[]> {
  const cases: Case[] = [];
  const caseDirs = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^(\d{2}|c\d)-/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of caseDirs) {
    if (only && name !== only) continue;
    const meta = parseYaml(await readFile(join(dir, name, "case.yaml"), "utf8")) as Omit<Case, "patch">;
    const patch = await readFile(join(dir, name, meta.control ? "control.patch" : "bug.patch"), "utf8");
    cases.push({ ...meta, breaks: meta.breaks ?? [], patch });
  }
  if (only && cases.length === 0) throw new Error(`no case named ${only}`);
  return cases;
}

/** `pass`, `fail one-order-per-cart 3/3`, `error 3/3`… for one experiment on one variant. */
function cell(result: ExperimentResult): string {
  const runs = result.reps.length;
  const rules = new Map<string, number>();
  for (const v of result.variants) for (const [id, n] of Object.entries(v.rules)) rules.set(id, (rules.get(id) ?? 0) + n);
  const errors = result.reps.filter((r) => r.outcome === "error").length;
  const parts = [result.outcome, ...[...rules].map(([id, n]) => `${id} ${n}/${runs}`)];
  if (errors && result.outcome !== "error") parts.push(`${errors} err`);
  if (result.outcome === "error") parts.push(`${errors}/${runs}`);
  return parts.join(" ");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repeat: { type: "string", default: "3" },
      case: { type: "string" },
      experiment: { type: "string", multiple: true },
      app: { type: "string", default: "shop" },
    },
  });
  const repeat = Number(values.repeat);
  const app = values.app;
  if (app !== "shop" && app !== "notes") throw new Error(`--app must be shop or notes, not ${app}`);
  const appDir = join(import.meta.dirname, "..", app);
  const casesDir = app === "shop" ? import.meta.dirname : join(appDir, "cases");
  const cases = await loadCases(casesDir, values.case);

  const runner = await Runner.open(appDir);
  stopOnSignals(() => runner.close());
  try {
    const experiments: Experiment[] = await loadExperiments(runner.project, values.experiment ?? []);
    for (const c of cases) {
      if (!c.control && !experiments.some((e) => e.id === c.experiment)) throw new Error(`${c.id}: experiment ${c.experiment} not selected`);
    }

    const variants: Variant[] = [];
    for (const spec of [{ id: "clean" }, ...cases.map((c) => ({ id: c.id, patch: c.patch, expected: c }))]) {
      const started = Date.now();
      const version = await runner.branches.versions.resolve({ patch: "patch" in spec ? spec.patch : undefined, label: spec.id });
      await runner.branches.prepare(version);
      console.log(`prepared ${spec.id.padEnd(30)} version ${version.id}  ${Date.now() - started} ms`);
      const expected = "expected" in spec ? spec.expected : undefined;
      variants.push({ id: spec.id, version, expected: expected?.control ? undefined : expected, clean: !expected || !!expected.control });
    }

    const started = Date.now();
    const results = await Promise.all(variants.map((v) => runner.run(experiments, { version: v.version, repeat })));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    // One line per variant: what didn't pass (the expected experiment first), then the count that passed.
    const failures: string[] = [];
    const width = Math.max(...variants.map((v) => v.id.length));
    console.log("");
    for (const [i, variant] of variants.entries()) {
      const expected = variant.expected;
      const outcomes = experiments.map((experiment) => {
        const result = results[i]!.find((r) => r.experiment === experiment.id)!;
        if (variant.clean && result.outcome !== "pass") {
          failures.push(`${variant.id === "clean" ? `clean ${app}` : `${variant.id} (control)`}: ${experiment.id} is ${cell(result)} (run ${result.runId})`);
        }
        if (expected?.experiment === experiment.id) {
          const reps = result.reps.filter((r) => !expected.variant || r.variant === expected.variant);
          const where = expected.variant ? ` of variant ${expected.variant}` : "";
          if (reps.length === 0) failures.push(`${variant.id}: no runs of variant ${expected.variant} (run ${result.runId})`);
          for (const id of expected.breaks) {
            const n = reps.filter((r) => r.broken.includes(id)).length;
            if (n !== reps.length) {
              failures.push(`${variant.id}: expected ${id} to break in ${reps.length}/${reps.length} runs${where}, got ${n} (run ${result.runId})`);
            }
          }
        }
        return { experiment: experiment.id, result };
      });
      const notPassing = outcomes
        .filter((o) => o.result.outcome !== "pass" || o.experiment === expected?.experiment)
        .sort((a, b) => Number(b.experiment === expected?.experiment) - Number(a.experiment === expected?.experiment))
        .map((o) => `${o.experiment === expected?.experiment ? "* " : ""}${o.experiment}: ${cell(o.result)}`);
      const passed = outcomes.filter((o) => o.result.outcome === "pass" && o.experiment !== expected?.experiment).length;
      const kind = variant.id === "clean" ? "" : expected ? "" : " (control)";
      console.log(`${variant.id.padEnd(width)}  ${[...notPassing, `${passed} ${expected ? "other(s) " : ""}pass`].join(" · ")}${kind}`);
    }
    console.log("(* the case's own experiment)");

    const runs = results.flat().reduce((n, r) => n + r.reps.length, 0);
    console.log(`\n${runs} runs in ${seconds} s`);
    for (const r of results.flat()) {
      for (const v of r.variants) if (v.firstError) console.log(`  error  ${r.version.label} / ${r.experiment}: ${v.firstError.message}`);
    }
    if (failures.length > 0) {
      console.log(`\nFAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      return 1;
    }
    const clean = cases.some((c) => c.control) ? `the clean ${app} and the controls pass` : `the clean ${app} app passes`;
    console.log(`\nPASS: ${clean} every experiment; each case breaks its rules in every run.`);
    return 0;
  } finally {
    await runner.close();
  }
}

process.exitCode = await main();

// Verifies the Bug Zoo end to end: the shop's experiments (zoo/shop/.windtunnel)
// run against the clean shop and every case variant, each run in its own branch.
//
//   pnpm zoo:verify [--repeat 3] [--case 02-lost-response-retry] [--experiment checkout-double-submit]
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
  experiment: string;
  breaks: string[];
  handler: string;
  patch: string;
}

interface Variant {
  id: string;
  version: CodeVersion;
  expected?: Case;
}

async function loadCases(dir: string, only?: string): Promise<Case[]> {
  const cases: Case[] = [];
  const caseDirs = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{2}-/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of caseDirs) {
    if (only && name !== only) continue;
    const meta = parseYaml(await readFile(join(dir, name, "case.yaml"), "utf8")) as Omit<Case, "patch">;
    cases.push({ ...meta, patch: await readFile(join(dir, name, "bug.patch"), "utf8") });
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
    },
  });
  const repeat = Number(values.repeat);
  const casesDir = import.meta.dirname;
  const cases = await loadCases(casesDir, values.case);

  const runner = await Runner.open(join(casesDir, "..", "shop"));
  stopOnSignals(() => runner.close());
  try {
    const experiments: Experiment[] = await loadExperiments(runner.project, values.experiment ?? []);
    for (const c of cases) {
      if (!experiments.some((e) => e.id === c.experiment)) throw new Error(`${c.id}: experiment ${c.experiment} not selected`);
    }

    const variants: Variant[] = [];
    for (const spec of [{ id: "clean" }, ...cases.map((c) => ({ id: c.id, patch: c.patch, expected: c }))]) {
      const started = Date.now();
      const version = await runner.branches.versions.resolve({ patch: "patch" in spec ? spec.patch : undefined, label: spec.id });
      await runner.branches.prepare(version);
      console.log(`prepared ${spec.id.padEnd(24)} version ${version.id}  ${Date.now() - started} ms`);
      variants.push({ id: spec.id, version, expected: "expected" in spec ? spec.expected : undefined });
    }

    const started = Date.now();
    const results = await Promise.all(variants.map((v) => runner.run(experiments, { version: v.version, repeat })));
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    // Matrix: one row per experiment, one column per variant.
    const failures: string[] = [];
    const header = ["experiment", ...variants.map((v) => v.id)];
    const rows = experiments.map((experiment) => [
      experiment.id,
      ...variants.map((variant, i) => {
        const result = results[i]!.find((r) => r.experiment === experiment.id)!;
        if (variant.id === "clean" && result.outcome !== "pass") {
          failures.push(`clean shop: ${experiment.id} is ${cell(result)} (run ${result.runId})`);
        }
        if (variant.expected?.experiment === experiment.id) {
          const runs = result.reps.length;
          for (const id of variant.expected.breaks) {
            const n = result.reps.filter((r) => r.broken.includes(id)).length;
            if (n !== runs) failures.push(`${variant.id}: expected ${id} to break in ${runs}/${runs} runs, got ${n} (run ${result.runId})`);
          }
        }
        return cell(result);
      }),
    ]);
    const widths = header.map((_, c) => Math.max(...[header, ...rows].map((r) => r[c]!.length)));
    console.log(`\n${[header, ...rows].map((r) => r.map((s, c) => s.padEnd(widths[c]!)).join("  ")).join("\n")}`);

    const runs = results.flat().reduce((n, r) => n + r.reps.length, 0);
    console.log(`\n${runs} runs in ${seconds} s`);
    for (const r of results.flat()) {
      for (const v of r.variants) if (v.firstError) console.log(`  error  ${r.version.label} / ${r.experiment}: ${v.firstError.message}`);
    }
    if (failures.length > 0) {
      console.log(`\nFAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      return 1;
    }
    console.log("\nPASS: the clean shop passes every experiment; each case breaks its rules in every run.");
    return 0;
  } finally {
    await runner.close();
  }
}

process.exitCode = await main();

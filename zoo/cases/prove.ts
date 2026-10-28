// Checks the prover against the Bug Zoo's answer key: for every case, the clean shop must be
// proven as the fix for its bug, and every wrong-fix.patch (a plausible fix that isn't one)
// must not be. The shop's own tests run in each proof; the other experiments do not unless
// --regression is given.
//
//   pnpm zoo:prove [--repeat 3] [--case 05-oversell] [--regression]
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type CodeVersionSpec, formatProof, loadExperiments, type ProofResult, prove, Runner, stopOnSignals } from "@windtunnel/core";
import { parse as parseYaml } from "yaml";

interface Check {
  name: string;
  experiment: string;
  base: CodeVersionSpec;
  fix: CodeVersionSpec;
  expect: "proven" | "not proven";
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      repeat: { type: "string", default: "3" },
      case: { type: "string" },
      regression: { type: "boolean", default: false },
    },
  });
  const casesDir = import.meta.dirname;
  const checks: Check[] = [];
  for (const name of (await readdir(casesDir)).filter((n) => /^\d{2}-/.test(n)).sort()) {
    if (values.case && name !== values.case) continue;
    const meta = parseYaml(await readFile(join(casesDir, name, "case.yaml"), "utf8")) as { experiment: string };
    const bug: CodeVersionSpec = { patch: await readFile(join(casesDir, name, "bug.patch"), "utf8"), label: `${name} bug` };
    checks.push({ name: `${name}: clean shop fixes it`, experiment: meta.experiment, base: bug, fix: { label: "clean shop" }, expect: "proven" });
    const wrong = await readFile(join(casesDir, name, "wrong-fix.patch"), "utf8").catch(() => undefined);
    if (wrong) {
      checks.push({ name: `${name}: wrong fix`, experiment: meta.experiment, base: bug, fix: { patch: wrong, label: `${name} wrong fix` }, expect: "not proven" });
    }
  }
  if (checks.length === 0) throw new Error(`no case named ${values.case}`);

  const runner = await Runner.open(join(casesDir, "..", "shop"));
  stopOnSignals(() => runner.close());
  try {
    const all = await loadExperiments(runner.project);
    const started = Date.now();
    const proofs = await Promise.all(
      checks.map(async (c): Promise<[Check, ProofResult | Error]> => {
        const experiments = all.filter((e) => e.id === c.experiment);
        if (experiments.length === 0) return [c, new Error(`no experiment ${c.experiment}`)];
        const proof = await prove(runner, {
          experiments,
          base: c.base,
          fix: c.fix,
          repeat: Number(values.repeat),
          regression: values.regression ? all.filter((e) => e.id !== c.experiment) : [],
        }).catch((err: Error) => err);
        return [c, proof];
      }),
    );

    const failures: string[] = [];
    for (const [check, proof] of proofs) {
      if (proof instanceof Error) {
        failures.push(`${check.name}: ${proof.message}`);
        continue;
      }
      const ok = proof.verdict === check.expect;
      console.log(`\n${ok ? "ok  " : "FAIL"} ${check.name}: ${proof.verdict}${ok ? "" : ` (expected ${check.expect})`}`);
      console.log(formatProof(proof).split("\n").map((l) => `     ${l}`).join("\n"));
      if (!ok) failures.push(`${check.name}: ${proof.verdict}, expected ${check.expect}`);
    }
    console.log(`\n${checks.length} proof(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (failures.length) {
      console.log(`\nFAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      return 1;
    }
    console.log("\nPASS: every real fix is proven and every wrong fix is rejected.");
    return 0;
  } finally {
    await runner.close();
  }
}

process.exitCode = await main();

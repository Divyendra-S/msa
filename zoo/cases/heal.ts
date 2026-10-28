// Checks failure sorting and selector repair on a copy of the Bug Zoo shop, rules only (no model):
// renamed controls are healed in the flow files and re-run; a changed confirmation message is never
// healed by rules; a broken rule is a bug; a failure only a perturbation causes goes to the agent.
//
//   pnpm zoo:heal [--keep]
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { clean, loadExperiments, Runner, stopOnSignals } from "@windtunnel/core";
import { Decider, DecisionStore, type FailureLabel, formatTriage, sortFailures } from "@windtunnel/explorer";

interface Scenario {
  name: string;
  experiment: string;
  /** Text replacements in the shop's files (paths relative to the shop). */
  edits?: { file: string; from: string; to: string }[];
  /** A case's bug.patch applied to the shop. */
  patch?: string;
  /** Files added to the shop copy, e.g. an extra experiment. */
  add?: Record<string, string>;
  expect: { label: FailureLabel | "for you"; healed?: string[]; to?: string; rerun?: "pass" };
}

const SCENARIOS: Scenario[] = [
  {
    name: "renamed button",
    experiment: "checkout-slow-payment",
    edits: [{ file: "components/PayButton.tsx", from: '"Pay now"', to: '"Place order"' }],
    expect: { label: "outdated-test", healed: [".windtunnel/flows/checkout.ts"], to: 'getByRole("button", { name: "Place order" })', rerun: "pass" },
  },
  {
    name: "renamed form label",
    experiment: "checkout-slow-payment",
    edits: [{ file: "components/LoginForm.tsx", from: "        Email\n", to: "        E-mail\n" }],
    expect: { label: "outdated-test", healed: [".windtunnel/flows/checkout.ts", ".windtunnel/flows/login.ts"], to: 'getByLabel("E-mail")', rerun: "pass" },
  },
  {
    name: "changed confirmation message (a check: never healed by rules)",
    experiment: "checkout-slow-payment",
    edits: [{ file: "components/OrderStatus.tsx", from: ">Order confirmed<", to: ">Order received<" }],
    expect: { label: "for you" },
  },
  {
    name: "real bug (case 05 oversell)",
    experiment: "checkout-two-buyers",
    patch: "05-oversell/bug.patch",
    expect: { label: "bug" },
  },
  {
    name: "fails only under its perturbation",
    experiment: "pay-503",
    add: {
      ".windtunnel/experiments/pay-503.yaml": 'flow: checkout\nperturb:\n  - { do: fail, request: "POST /api/orders", status: 503 }\nrepeat: 1\n',
    },
    expect: { label: "for you" },
  },
];

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { keep: { type: "boolean", default: false } } });
  const casesDir = import.meta.dirname;
  const shop = join(casesDir, "..", "shop");
  const copy = await realpath(await mkdtemp(join(tmpdir(), "wt-zoo-heal-")));
  const skip = /(^|\/)(node_modules|\.next|tsconfig\.tsbuildinfo|next-env\.d\.ts)$|^\.windtunnel\/(runs|logs|pids|cache)$/;
  await cp(shop, copy, { recursive: true, filter: (src) => !skip.test(relative(shop, src)) });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: copy, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=zoo", "-c", "user.email=zoo@example.test", "commit", "-qm", "clean shop");

  const runner = await Runner.open(copy);
  stopOnSignals(async () => {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner.close();
  });
  const failures: string[] = [];
  const started = Date.now();
  try {
    for (const s of SCENARIOS) {
      for (const e of s.edits ?? []) {
        const file = join(copy, e.file);
        const text = await readFile(file, "utf8");
        if (!text.includes(e.from)) throw new Error(`${s.name}: "${e.from}" not in ${e.file}`);
        await writeFile(file, text.replace(e.from, e.to));
      }
      if (s.patch) git("apply", "-p3", join(casesDir, s.patch));
      for (const [path, text] of Object.entries(s.add ?? {})) await writeFile(join(copy, path), text);

      const experiments = await loadExperiments(runner.project, [s.experiment]);
      const results = await runner.run(experiments, { repeat: 1, trace: "off" });
      const decisions = new DecisionStore(runner.project.stateDir);
      // Rules only, whatever keys are set: the check must not depend on a model.
      const entries = await sortFailures(runner, results, experiments, { decider: new Decider({}), decisions });
      const entry = entries[0];
      const got = !entry ? "pass" : entry.label ?? "for you";
      const healed = [...new Set((entry?.healed ?? []).map((h) => h.file))].sort();
      const problems = [
        got !== s.expect.label && `sorted as ${got}, expected ${s.expect.label}`,
        JSON.stringify(healed) !== JSON.stringify(s.expect.healed ?? []) && `healed ${healed.join(", ") || "nothing"}, expected ${s.expect.healed?.join(", ") || "nothing"}`,
        s.expect.to && entry?.healed?.some((h) => h.to !== s.expect.to) && `healed to ${entry.healed.map((h) => h.to).join(", ")}, expected ${s.expect.to}`,
        s.expect.rerun && entry?.rerun?.outcome !== s.expect.rerun && `re-run ${entry?.rerun?.outcome ?? "missing"}, expected ${s.expect.rerun}`,
        !s.expect.healed && git("status", "--porcelain", "--", ".windtunnel/flows") !== "" && "a flow file changed",
      ].filter((p): p is string => !!p);
      console.log(`\n${problems.length ? "FAIL" : "ok  "} ${s.name}`);
      console.log(formatTriage(entries, "rules, then you").split("\n").map((l) => `     ${l}`).join("\n"));
      for (const p of problems) failures.push(`${s.name}: ${p}`);

      // Back to the clean shop, flows included, for the next scenario.
      git("checkout", "-q", "--", ".");
      git("clean", "-qfd", "--", "components", "app", "lib", ".windtunnel/experiments");
      for (const d of await decisions.open()) await decisions.save({ ...d, answered: { at: new Date().toISOString(), answer: "-", result: "zoo:heal reset" } });
    }
    console.log(`\n${SCENARIOS.length} scenario(s) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (failures.length) {
      console.log(`\nFAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      return 1;
    }
    console.log("\nPASS: renamed controls are healed and re-run, checks and bugs are not papered over.");
    return 0;
  } finally {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner.close();
    if (!values.keep) await rm(copy, { recursive: true, force: true });
    else console.log(`kept ${copy}`);
  }
}

process.exitCode = await main();

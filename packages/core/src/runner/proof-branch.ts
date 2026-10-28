import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ConfigError } from "../config.ts";
import { changedFiles, createBranchCommit, diffStat, git, resolveRef } from "../git.ts";
import { exists } from "../project.ts";
import { RULES_FILE, type Rule } from "../rules.ts";
import { evidencePacket } from "./evidence.ts";
import type { Experiment } from "./experiment.ts";
import { flowFiles } from "./inputs.ts";
import type { ProofResult } from "./prove.ts";
import type { ExperimentResult, Runner } from "./runner.ts";

export interface ProofBranchOptions {
  /** Branch to create, e.g. `windtunnel/fix-oversell`. */
  name: string;
  /** The commit the fix goes on top of (default HEAD): the base the proof ran on. */
  parent?: string;
  /** The experiments that reproduce the bug: committed as regression experiments. */
  experiments: Experiment[];
  rules?: Rule[];
  handlerFor?: (method: string, path: string) => string | undefined;
  /** Commit message (default: generated from the proof). Its first line titles the evidence file too. */
  message?: string;
}

export interface ProofBranch {
  name: string;
  commit: string;
  /** Wind Tunnel files the commit adds or updates (beside the fix), relative to the repository. */
  added: string[];
  /** The evidence file inside the branch. */
  evidence: string;
  /** A copy outside the branch, e.g. for `gh pr create --body-file`. */
  evidenceCopy: string;
  /** The remote to push to (origin if there is one); absent when the repository has none. */
  remote?: string;
}

/**
 * Turns a proven fix into a branch: one commit on `parent` with the fix, the experiments
 * that reproduce the bug (with their flows and the rules file), and `.windtunnel/evidence/<slug>.md`.
 * The working tree and the current branch are left alone.
 */
export async function writeProofBranch(runner: Runner, proof: ProofResult, options: ProofBranchOptions): Promise<ProofBranch> {
  if (proof.verdict !== "proven") throw new ConfigError(`the fix is not proven, so no branch was created:\n${proof.reasons.map((r) => `  - ${r}`).join("\n")}`);
  const project = runner.project;
  const toRepo = (file: string) => relative(project.repoRoot, file).split(sep).join("/");
  const slug = options.experiments.map((e) => e.id).join("-").slice(0, 60);

  const files = new Set<string>();
  for (const e of options.experiments) {
    if (e.file) files.add(e.file);
    for (const f of await flowFiles(project, e)) files.add(f);
  }
  for (const name of [RULES_FILE, ".gitignore"]) {
    const file = join(project.stateDir, name);
    if (await exists(file)) files.add(file);
  }

  const parent = options.parent ?? "HEAD";
  // A commit id, so the evidence still names the buggy code after the branch is merged.
  const base = (await resolveRef(project.repoRoot, parent)).commit.slice(0, 12);
  const windtunnelDir = toRepo(project.stateDir);
  const stat = await diffStat(project.repoRoot, parent, proof.fix.version.tree, [windtunnelDir]).catch(() => "");
  const message = options.message?.trim() || defaultMessage(proof, options.experiments, base);
  const title = message.split("\n")[0]!;
  const markdown = await proofMarkdown(runner, proof, { title, parent: base, stat, rules: options.rules, handlerFor: options.handlerFor, experiments: options.experiments });
  const copy = join(project.stateDir, "logs", "evidence", `${slug}.md`);
  await mkdir(join(project.stateDir, "logs", "evidence"), { recursive: true });
  await writeFile(copy, markdown);

  const evidence = `${windtunnelDir}/evidence/${slug}.md`;
  const commit = await createBranchCommit(project.repoRoot, {
    name: options.name,
    parent,
    tree: proof.fix.version.tree,
    restore: windtunnelDir,
    files: [...[...files].map((f) => ({ path: toRepo(f), source: f })), { path: evidence, source: copy }],
    message: `${message}\n\nEvidence: ${evidence}`,
  });
  // Files already committed as they are don't count as added.
  const added = (await changedFiles(project.repoRoot, parent, commit)).map((c) => c.path).filter((p) => p.startsWith(`${windtunnelDir}/`));
  const remotes = (await git(["remote"], project.repoRoot).catch(() => "")).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  return { name: options.name, commit, added, evidence, evidenceCopy: copy, ...(remote ? { remote } : {}) };
}

/** `Fix stock-non-negative (checkout-two-buyers)` and how it was proven. */
function defaultMessage(proof: ProofResult, experiments: Experiment[], parent: string): string {
  const rules = [...new Set(proof.base.results.flatMap((r) => r.reps.flatMap((x) => x.broken)))];
  const lines = [`Fix ${rules.join(", ") || "failing experiments"} (${experiments.map((e) => e.id).join(", ")})`, ""];
  for (const r of proof.base.results) {
    const failing = r.variants.filter((v) => v.outcome === "fail").map((v) => v.variant);
    const where =
      failing.length === r.variants.length ? "every run" : `every run of the ${failing.join(", ")} ordering${failing.length > 1 ? "s" : ""}`;
    lines.push(`${r.experiment} failed on ${parent} in ${where}; it passes with this change in every ordering`);
  }
  lines.push(`(${proof.repeat} runs each) and fails again without it. Proven by Wind Tunnel.`);
  return lines.join("\n");
}

async function proofMarkdown(
  runner: Runner,
  proof: ProofResult,
  context: { title: string; parent: string; stat: string; rules?: Rule[]; handlerFor?: ProofBranchOptions["handlerFor"]; experiments: Experiment[] },
): Promise<string> {
  const counts = (r: ExperimentResult) => {
    if (r.outcome === "pass") return `${r.reps.length}/${r.reps.length} runs held every rule`;
    const rules = [...new Set(r.variants.flatMap((v) => Object.keys(v.rules)))];
    const errors = r.reps.filter((x) => x.outcome === "error").length;
    // Per ordering, so "fails every time" reads right when only one ordering breaks.
    const broken = rules.map((id) =>
      r.variants.length > 1
        ? `\`${id}\` broken in ${r.variants.map((v) => `${v.variant} ${v.rules[id] ?? 0}/${v.runs}`).join(", ")}`
        : `\`${id}\` broken in ${r.variants[0]!.rules[id]}/${r.variants[0]!.runs}`,
    );
    return [...broken, errors ? `${errors}/${r.reps.length} errored` : ""].filter(Boolean).join("; ");
  };
  const lines: string[] = [];
  const ids = context.experiments.map((e) => `\`${e.id}\``).join(", ");
  lines.push(`# ${context.title}`, "");
  for (const e of context.experiments) if (e.description) lines.push(`> ${e.id}: ${e.description}`, "");
  lines.push(`Proven by Wind Tunnel on ${new Date().toISOString().slice(0, 10)}: ${ids} ${context.experiments.length === 1 ? "reproduces" : "reproduce"} the bug on \`${context.parent}\` and ${context.experiments.length === 1 ? "passes" : "pass"} with this change.`, "");

  const code = (v: ProofResult["base"]["version"]) => `${v.label}${v.base ? ` @ ${v.base.slice(0, 12)}` : ""}`;
  lines.push("## Proof", "", "| Experiment | Stage | Code | Result | Detail | Run |", "|---|---|---|---|---|---|");
  for (const b of proof.base.results) {
    const rows: [string, string, ExperimentResult | undefined][] = [
      ["base", code(proof.base.version), b],
      ["fix", code(proof.fix.version), proof.fix.results.find((x) => x.experiment === b.experiment)],
      ["revert", code(proof.base.version), proof.revert.find((x) => x.experiment === b.experiment)],
    ];
    for (const [stage, code, r] of rows) {
      if (r) lines.push(`| \`${b.experiment}\` | ${stage} | ${code} | ${r.outcome.toUpperCase()} | ${counts(r)} | ${r.runId} |`);
    }
  }
  const orderings = proof.fix.results.flatMap((r) => r.variants.map((v) => v.variant)).filter((v) => v !== "default");
  lines.push("");
  if (orderings.length) lines.push(`- Every ordering ran ${proof.repeat} times: ${[...new Set(orderings)].map((o) => `\`${o}\``).join(", ")}.`);
  else lines.push(`- ${proof.repeat} runs per stage.`);
  const worse = proof.regression.filter((r) => r.base === "pass" && r.fix !== "pass");
  const both = proof.regression.filter((r) => r.base === "pass" && r.fix === "pass").length;
  if (proof.regression.length) lines.push(`- Regression set: ${proof.regression.length} other experiment(s); ${both} pass on the base and with the fix${worse.length ? `; ${worse.length} got worse` : ""}.`);
  if (proof.tests) lines.push(`- Project tests (\`${proof.tests.fix.command}\`): ${proof.tests.base.ok ? "pass" : "fail"} on the base, ${proof.tests.fix.ok ? "pass" : "fail"} with the fix.`);
  lines.push("");

  if (context.stat) lines.push("## Changed files", "", "```", context.stat, "```", "");

  lines.push("## The bug, before the fix", "");
  for (const b of proof.base.results) {
    const packet = await evidencePacket(runner.store, b.runId, { rules: context.rules, handlerFor: context.handlerFor, source: runner.project, maxChars: 6_000 }).catch(() => "");
    // Absolute paths (traces on this machine) mean nothing to a reviewer.
    const shareable = packet.split("\n").filter((l) => !l.startsWith("Playwright trace:") && !l.startsWith("Drill down:")).join("\n").trim();
    if (shareable) lines.push(`<details><summary>Evidence from base run ${b.runId} (${b.experiment})</summary>`, "", "```text", shareable, "```", "", "</details>", "");
  }

  lines.push(
    "## Re-run",
    "",
    "```sh",
    `windtunnel run ${context.experiments.map((e) => e.id).join(" ")}`,
    `windtunnel prove ${context.experiments.map((e) => e.id).join(" ")} --base ${context.parent}`,
    "```",
    "",
  );
  return lines.join("\n");
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Project } from "../project.ts";
import type { Rule } from "../rules.ts";
import type { Experiment } from "./experiment.ts";
import { findFlowFile, LOGIN_FLOW } from "./flows.ts";

/**
 * A hash of everything about an experiment that lives outside the app code: the experiment
 * itself, its flow and the login flow (with the local files they import), and the rules it
 * checks. A cached result is only reused while this stays the same.
 */
export async function experimentInputs(project: Project, experiment: Experiment, rules: Rule[]): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ ...experiment, file: undefined }));
  for (const file of await flowFiles(project, experiment)) hash.update(`\0${relative(project.stateDir, file)}\0${await readFile(file, "utf8").catch(() => "")}`);
  const used = experiment.rules === "all" ? rules : rules.filter((r) => experiment.rules.includes(r.id));
  for (const r of [...used].sort((a, b) => a.id.localeCompare(b.id))) hash.update(`\0rule ${r.id}\0${r.sql}\0${r.expect}`);
  return hash.digest("hex").slice(0, 16);
}

/** The experiment's flow and the login flow, with the local files they import. */
export async function flowFiles(project: Project, experiment: Experiment): Promise<string[]> {
  const files = new Set<string>();
  for (const name of [experiment.flow, LOGIN_FLOW]) {
    const file = await findFlowFile(project.stateDir, name);
    if (file) await collect(file, files);
  }
  return [...files].sort();
}

/** A flow file and the local files it imports, transitively. */
async function collect(file: string, into: Set<string>): Promise<void> {
  if (into.has(file)) return;
  const source = await readFile(file, "utf8").catch(() => undefined);
  if (source === undefined) return;
  into.add(file);
  for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = resolve(dirname(file), m[1]!);
    for (const candidate of [base, `${base}.ts`, `${base}.mts`, `${base}.js`, `${base}.mjs`]) {
      if (await readFile(candidate).then(() => true, () => false)) {
        await collect(candidate, into);
        break;
      }
    }
  }
}

import { relative } from "node:path";
import type { ExperimentResult } from "./runner.ts";

/** A compact table: one row per experiment variant. */
export function formatResults(results: ExperimentResult[], cwd = process.cwd()): string {
  const rows: string[][] = [["experiment", "variant", "result", "runs", "rules broken", "run"]];
  const notes: string[] = [];
  for (const result of results) {
    result.variants.forEach((v, i) => {
      const counts = [v.ok && `${v.ok} ok`, v.broken && `${v.broken} broken`, v.errors && `${v.errors} error`]
        .filter(Boolean)
        .join(", ");
      const rules = Object.entries(v.rules)
        .map(([id, n]) => `${id} ${n}/${v.runs}`)
        .join(", ");
      rows.push([
        i === 0 ? result.experiment : "",
        v.variant === "default" ? "" : v.variant,
        v.outcome.toUpperCase(),
        counts,
        rules || "—",
        i === 0 ? result.runId : "",
      ]);
      if (v.firstError) {
        notes.push(`${result.experiment}${v.variant === "default" ? "" : ` [${v.variant}]`} run ${v.firstError.rep}: ${v.firstError.message}`);
      }
    });
  }
  // The variant column only matters when an experiment runs several orderings.
  const shown = rows.map((r) => (rows.slice(1).some((x) => x[1]) ? r : [r[0]!, ...r.slice(2)]));
  const widths = shown[0]!.map((_, c) => Math.max(...shown.map((r) => r[c]!.length)));
  const table = shown.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
  const warnings = results.flatMap((r) => (r.warnings ?? []).map((w) => `${r.experiment}: ${w}`));
  const runs = results.reduce((n, r) => n + r.reps.length, 0);
  const seconds = Math.max(0, ...results.map((r) => r.durationMs)) / 1000;
  const version = results[0]?.version;
  const storeDir = results[0]?.dir.replace(/\/[^/]+$/, "");
  const rel = storeDir ? relative(cwd, storeDir) : "";
  const store = storeDir ? (rel.startsWith("..") ? storeDir : rel || ".") : "";
  return [
    version ? `version ${version.id} (${version.label})\n` : "",
    table,
    "",
    `${results.length} experiment(s) · ${runs} run(s) · ${seconds.toFixed(1)} s · details in ${store}/<run>`,
    ...(notes.length ? ["", "errors:", ...notes.map((n) => `  ${n}`)] : []),
    ...(warnings.length ? ["", "not exercised (a pass here proves less):", ...warnings.map((w) => `  ${w}`)] : []),
  ].join("\n");
}

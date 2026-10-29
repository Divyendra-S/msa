import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TrialScore } from "./score.ts";
import { SETUPS, type Setup } from "./trial.ts";

export async function loadScores(batchDir: string): Promise<TrialScore[]> {
  const files = (await readdir(batchDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json") && !f.endsWith(".report.json"));
  const scores: TrialScore[] = [];
  for (const f of files.sort()) {
    const data = JSON.parse(await readFile(join(batchDir, f), "utf8")) as TrialScore;
    if (data.trial && data.setup) scores.push(data);
  }
  return scores;
}

function kilo(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
}

function minutes(ms: number | undefined): string {
  return ms === undefined ? "–" : `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)} min`;
}

function usd(n: number, estimated = false): string {
  return `${estimated ? "~" : ""}$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}

const tokens = (s: TrialScore) => s.usage.input + s.usage.output;
const isFixed = (s: TrialScore) => !!s.fixed && s.fixed.ok === s.fixed.runs && s.fixed.runs > 0;

/** The scoreboard as Markdown: totals per setup, then one row per trial. */
export function renderBoard(scores: TrialScore[], title: string): string {
  const setups = [...new Set(scores.map((s) => s.setup))].sort() as Setup[];
  const lines = [`# Bug Zoo scoreboard: ${title}`, ""];
  const hosts = [...new Set(scores.map((s) => `${s.host}${s.model ? ` (${s.model})` : ""}`))];
  lines.push(`Host: ${hosts.join(", ")}. Scored without a model: a finding counts as found when its reproduce command fails with the bug and passes on the clean shop; fixed means the case's hidden experiment passes in every run on the agent's final code.`, "");

  lines.push("| Setup | Bugs found (reproduced) | Correct file | Fixed | Regressions | False alarms (controls / bug cases) | Tokens | Credits | Time | Tokens per fix |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const setup of setups) {
    const all = scores.filter((s) => s.setup === setup);
    const bugs = all.filter((s) => !s.control);
    const controls = all.filter((s) => s.control);
    const fixed = bugs.filter(isFixed).length;
    const total = all.reduce((n, s) => n + tokens(s), 0);
    const cost = all.reduce((n, s) => n + s.usage.usd, 0);
    const time = all.reduce((n, s) => n + (s.wallMs ?? 0), 0);
    lines.push(
      `| ${setup}: ${SETUPS[setup].title} | ${bugs.filter((s) => s.found === "yes").length}/${bugs.length}${bugs.some((s) => s.found === "claimed") ? ` (+${bugs.filter((s) => s.found === "claimed").length} claimed)` : ""} | ${bugs.filter((s) => s.handler).length}/${bugs.length} | ${fixed}/${bugs.length} | ${all.reduce((n, s) => n + s.regressions.length, 0)} | ${controls.reduce((n, s) => n + s.falseAlarms, 0)} / ${bugs.reduce((n, s) => n + s.falseAlarms, 0)} | ${kilo(total)} | ${usd(cost, all.some((s) => s.usage.estimated))} | ${minutes(time)} | ${fixed ? kilo(Math.round(total / fixed)) : "–"} |`,
    );
  }

  lines.push("", "| Case | Setup | Found | Reproduced | File | Fixed (hidden) | Regressions | False alarms | Tokens | Credits | Time | Notes |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  const order = (s: TrialScore) => `${s.control ? "1" : "0"}${s.case}${s.setup}${s.trial}`;
  for (const s of [...scores].sort((a, b) => order(a).localeCompare(order(b)))) {
    const found = s.control ? "–" : s.found === "yes" ? "✓" : s.found === "claimed" ? "claimed" : "✗";
    const fixed = s.control ? "–" : s.fixed ? `${isFixed(s) ? "✓" : "✗"} ${s.fixed.ok}/${s.fixed.runs}` : "?";
    lines.push(
      `| ${s.case} | ${s.setup} | ${found} | ${s.control ? "–" : (s.reproduced ?? "–")} | ${s.control ? "–" : s.handler ? "✓" : "✗"} | ${fixed} | ${s.regressions.length || "–"} | ${s.falseAlarms || "–"} | ${kilo(tokens(s))} | ${usd(s.usage.usd, s.usage.estimated)} | ${minutes(s.wallMs)} | ${[...(s.timedOut ? ["time cap"] : []), ...s.notes.filter((n) => !/time cap|by hand/.test(n))].join("; ").replace(/\|/g, "/") || ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function writeBoard(batchDir: string, title: string): Promise<{ path: string; text: string }> {
  const text = renderBoard(await loadScores(batchDir), title);
  const path = join(batchDir, "scoreboard.md");
  await writeFile(path, text);
  return { path, text };
}

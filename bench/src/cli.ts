// Bug Zoo benchmark: the same task for setups A (no Wind Tunnel), B (rules only) and C (Muse Spark
// at Level 1) on each case, scored without a model. See bench/README.md.
//
//   pnpm bench run --cases all --setups A,B,C [--host muse] [--time-cap 30m]
//   pnpm bench prepare --case 05 --setup B [--host manual]
//   pnpm bench score <trial folder> [--tokens <n> --minutes <m>]
//   pnpm bench board [--batch <name>]
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { writeBoard } from "./board.ts";
import { loadCases, REPO_ROOT } from "./cases.ts";
import { DEFAULT_MODEL, manualInstructions, MUSE_COMMAND, refusedHost, runHost } from "./hosts.ts";
import { publishScore, type ScoreOptions, scoreTrial, type TrialScore } from "./score.ts";
import { loadTrial, prepareTrial, type Setup, SETUPS, trialName } from "./trial.ts";

const RESULTS_DIR = join(REPO_ROOT, "bench", "results");
const DEFAULT_TRIALS = join(tmpdir(), "windtunnel-bench");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    case: { type: "string", multiple: true },
    cases: { type: "string", multiple: true },
    setup: { type: "string", multiple: true },
    setups: { type: "string", multiple: true },
    host: { type: "string", default: "muse" },
    command: { type: "string" },
    model: { type: "string" },
    "max-steps": { type: "string", default: "200" },
    "time-cap": { type: "string", default: "30m" },
    batch: { type: "string" },
    trials: { type: "string", default: DEFAULT_TRIALS },
    "no-install": { type: "boolean", default: false },
    "no-score": { type: "boolean", default: false },
    "no-publish": { type: "boolean", default: false },
    "shared-home": { type: "boolean", default: false },
    "fix-runs": { type: "string" },
    "regression-runs": { type: "string" },
    "repro-runs": { type: "string" },
    tokens: { type: "string" },
    minutes: { type: "string" },
    usd: { type: "string" },
    quiet: { type: "boolean", default: false },
    parallel: { type: "string", default: "1" },
  },
});

function duration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(text.trim());
  if (!m) throw new Error(`bad duration "${text}": use e.g. 30m, 90s, 1h`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
}

function num(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`not a number: ${text}`);
  return n;
}

function setupsOf(list: string[] | undefined, fallback: Setup[]): Setup[] {
  const out = (list ?? []).flatMap((s) => s.split(",")).map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const s of out) if (!(s in SETUPS)) throw new Error(`unknown setup ${s}: use A, B or C`);
  return out.length ? (out as Setup[]) : fallback;
}

function batchName(host: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear()).slice(2)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${host}`;
}

function scoreOptions(): ScoreOptions {
  return {
    ...(values["fix-runs"] ? { fixRuns: num(values["fix-runs"]) } : {}),
    ...(values["regression-runs"] ? { regressionRuns: num(values["regression-runs"]) } : {}),
    ...(values["repro-runs"] ? { reproRuns: num(values["repro-runs"]) } : {}),
    ...(values.tokens ? { tokens: num(values.tokens) } : {}),
    ...(values.minutes ? { minutes: num(values.minutes) } : {}),
    ...(values.usd ? { usd: num(values.usd) } : {}),
    log: values.quiet ? undefined : (line) => console.log(`  ${line}`),
  };
}

function summary(s: TrialScore): string {
  if (s.control) return `${s.trial}: control · false alarms ${s.falseAlarms} · regressions ${s.regressions.length}`;
  const fixed = s.fixed ? `${s.fixed.ok}/${s.fixed.runs}` : "?";
  return `${s.trial}: found ${s.found}${s.reproduced ? ` (${s.reproduced})` : ""} · file ${s.handler ? "✓" : "✗"} · fixed ${fixed} · regressions ${s.regressions.length} · false alarms ${s.falseAlarms}${s.notes.length ? `\n    ${s.notes.join("\n    ")}` : ""}`;
}

async function main(): Promise<number> {
  const [command, ...rest] = positionals;
  const command_ = values.command ? values.command.split(" ").filter(Boolean) : undefined;
  const host = values.command ? "command" : values.host!;
  const model = values.model ?? (host === "muse" ? DEFAULT_MODEL : undefined);

  if (command === "prepare" || command === "run") {
    const cases = await loadCases(command === "prepare" ? (values.case ?? values.cases ?? []) : (values.cases ?? values.case ?? ["all"]));
    if (command === "prepare" && cases.length !== 1) throw new Error("prepare: name one case (--case 05)");
    const setups = setupsOf(values.setups ?? values.setup, command === "prepare" ? [] : ["A", "B", "C"]);
    if (setups.length === 0) throw new Error("name the setup: --setup A, B or C");
    if (host !== "manual") {
      const refused = refusedHost(command_ ?? MUSE_COMMAND);
      if (refused) throw new Error(refused);
    }
    if (command === "run" && host === "manual") throw new Error("run --host manual: use prepare for each trial, then score");
    const batch = values.batch ?? batchName(host);
    const trialsDir = resolve(values.trials!);
    const timeCapMs = duration(values["time-cap"]!);

    const jobs = cases.flatMap((zooCase) => setups.map((setup) => ({ zooCase, setup })));
    if (command === "prepare") {
      for (const { zooCase, setup } of jobs) {
        const trial = await prepareTrial(zooCase, setup, { trialsDir, batch, host, model, timeCapMs, install: !values["no-install"] });
        console.log(host === "manual" ? manualInstructions(trial) : `prepared ${trial.dir}`);
      }
      return 0;
    }

    // Agents run in parallel slots, each with its own PORT; scoring runs one trial at a time, so
    // reproductions that start the shop on a fixed port don't collide.
    const parallel = Math.max(1, num(values.parallel) ?? 1);
    let next = 0;
    let scoring: Promise<unknown> = Promise.resolve();
    const scored: Promise<unknown>[] = [];
    const worker = async (slot: number) => {
      while (next < jobs.length) {
        const { zooCase, setup } = jobs[next++]!;
        const trial = await prepareTrial(zooCase, setup, { trialsDir, batch, host, model, timeCapMs, install: !values["no-install"] });
        const name = trialName(trial);
        const say = (line: string) => console.log(parallel > 1 ? `[${name}] ${line}` : line);
        say(`${host}${model ? ` (${model})` : ""}, cap ${values["time-cap"]} · ${trial.dir}`);
        const run = await runHost(trial, {
          command: command_,
          model,
          maxSteps: num(values["max-steps"]),
          isolateHome: !values["shared-home"],
          env: { PORT: String(3100 + slot * 10) },
          onEvent: values.quiet ? undefined : (line) => say(`  ${line}`),
        });
        say(`exit ${run.exitCode}${run.timedOut ? " (time cap)" : ""} after ${(run.wallMs / 60_000).toFixed(1)} min · ${run.usage.input + run.usage.output} tokens`);
        if (values["no-score"]) continue;
        const done = scoring.then(async () => {
          const score = await scoreTrial(trial, zooCase, { ...scoreOptions(), log: values.quiet ? undefined : (line) => say(`  ${line}`) });
          if (!values["no-publish"]) await publishScore(trial, score, RESULTS_DIR);
          say(summary(score));
        });
        scoring = done.catch(() => undefined);
        scored.push(done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, (_, slot) => worker(slot)));
    const failed = (await Promise.allSettled(scored)).filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const f of failed) console.error(`scoring failed: ${(f.reason as Error).message}`);
    if (command === "run" && !values["no-score"] && !values["no-publish"]) {
      const { path, text } = await writeBoard(join(RESULTS_DIR, batch), batch);
      console.log(`\n${text}\nscoreboard: ${path}`);
    }
    return 0;
  }

  if (command === "score") {
    if (!rest[0]) throw new Error("score <trial folder>");
    const trial = await loadTrial(resolve(rest[0]));
    const [zooCase] = await loadCases([trial.case]);
    const score = await scoreTrial(trial, zooCase!, scoreOptions());
    console.log(summary(score));
    if (!values["no-publish"]) {
      const dir = await publishScore(trial, score, RESULTS_DIR);
      const { path } = await writeBoard(dir, trial.batch);
      console.log(`results: ${dir}\nscoreboard: ${path}`);
    }
    return 0;
  }

  if (command === "board") {
    const batch = values.batch ?? (await readdir(RESULTS_DIR).catch(() => [] as string[])).filter((d) => !d.startsWith(".")).sort().at(-1);
    if (!batch) throw new Error(`no results in ${RESULTS_DIR}`);
    const { path, text } = await writeBoard(join(RESULTS_DIR, batch), batch);
    console.log(`${text}\n${path}`);
    return 0;
  }

  console.log(
    [
      "usage: pnpm bench <command>",
      "  run      --cases all|bugs|controls|05,c1 --setups A,B,C [--host muse | --command \"<cmd> {prompt_file}\"] [--model muse-wonder-1.0] [--time-cap 30m] [--max-steps 200]",
      "  prepare  --case 05 --setup B [--host manual]     make one trial folder (manual: prints what to run in Claude Code)",
      "  score    <trial folder> [--tokens n --minutes m] score a finished trial and add it to bench/results",
      "  board    [--batch <name>]                        print and write the scoreboard",
      "options: --batch <name> --trials <dir> (default $TMPDIR/windtunnel-bench) --parallel 1 --fix-runs 5 --regression-runs 1 --repro-runs 3 --no-install --no-score --no-publish --shared-home --quiet",
    ].join("\n"),
  );
  return command ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`bench: ${(err as Error).message}`);
  process.exitCode = 1;
}

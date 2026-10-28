import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  type CodeVersionSpec,
  CONTROL_ROLES,
  type DecidedBy,
  describeElement,
  type Experiment,
  type ExperimentResult,
  type FlowError,
  flowFiles,
  type PageSnapshot,
  type Runner,
} from "@windtunnel/core";
import { type Decider, type DecisionStore, formatDecision, type PendingDecision, type Question } from "./decider.ts";
import {
  ACTS,
  type Candidate,
  candidateLabel,
  findInSource,
  parseLocator,
  rankCandidates,
  replaceInSource,
  restoreSource,
  rulesPick,
  type SourceMatch,
  withExact,
} from "./repair.ts";

/** bug: the app is wrong · flaky: the run itself is unreliable · outdated-test: the flow or rule no longer fits the app · environment: the machine, not the app. */
export type FailureLabel = "bug" | "flaky" | "outdated-test" | "environment";

export interface Heal {
  file: string;
  lines: number[];
  from: string;
  to: string;
}

export interface TriageEntry {
  experiment: string;
  runId: string;
  /** Undefined while a decision waits for the agent. */
  label?: FailureLabel;
  reason: string;
  by: DecidedBy;
  /** Locators rewritten in flow files, each checked by a run without perturbations. */
  healed?: Heal[];
  /** The experiment run again after healing. */
  rerun?: ExperimentResult;
  /** Waiting for the agent: windtunnel_decide id=<decision>. */
  decision?: PendingDecision;
}

export interface TriageOptions {
  decider: Decider;
  decisions: DecisionStore;
  /** The code the results ran on (default: the working tree). */
  version?: CodeVersionSpec;
  /** Rewrite renamed locators in flow files (default true). */
  heal?: boolean;
  onProgress?: (message: string) => void;
}

/** Environment failures: the machine, the database or the browser, not the app. */
const ENVIRONMENT = /could not start the branch|ECONNREFUSED .*:(5432|55432)\b|too many (clients|connections)|EADDRINUSE|Executable doesn't exist|browserType\.launch|ENOSPC|out of memory|ENOMEM|the database system is (starting|shutting) up/i;
const MAX_HEALS = 3;

interface RepFile {
  rep: number;
  outcome: string;
  error?: string;
  errors?: FlowError[];
}

/**
 * Sorts each experiment that didn't pass into bug / flaky / outdated test / environment.
 * Plain code decides what it can: broken rules are bugs, mixed results are flaky, known
 * machine errors are environment. A flow that fails in every run is run once more without
 * perturbations: if it fails there too on a locator, the locator is healed in the flow file
 * (checked by another run) and the experiment re-run; otherwise the Decider is asked.
 */
export async function sortFailures(runner: Runner, results: ExperimentResult[], experiments: Experiment[], options: TriageOptions): Promise<TriageEntry[]> {
  const out: TriageEntry[] = [];
  const needControl: { result: ExperimentResult; experiment: Experiment; errors: FlowError[] }[] = [];
  for (const result of results) {
    if (result.outcome === "pass") continue;
    const experiment = experiments.find((e) => e.id === result.experiment);
    const entry = await byRules(result);
    if (entry) {
      out.push(entry);
      await options.decider.record("triage", "rules");
    } else if (experiment) {
      needControl.push({ result, experiment, errors: (await repFiles(runner, result)).flatMap((r) => r.errors ?? []) });
    }
  }
  if (needControl.length === 0) return save(out);

  options.onProgress?.(`sorting ${needControl.length} failure(s): one run each without perturbations`);
  const controls = await runner.run(needControl.map((n) => controlOf(n.experiment)), { version: options.version, repeat: 1, trace: "off" });
  for (const [i, { result, experiment, errors }] of needControl.entries()) {
    out.push(await afterControl(runner, result, experiment, errors, controls[i]!, options));
  }
  return save(out);

  async function save(entries: TriageEntry[]): Promise<TriageEntry[]> {
    for (const e of entries) {
      const result = results.find((r) => r.runId === e.runId);
      if (result) await writeTriage(result.dir, e);
    }
    return entries;
  }
}

/** What plain code can settle without running anything. */
async function byRules(result: ExperimentResult): Promise<TriageEntry | undefined> {
  const reps = result.reps;
  const total = reps.length;
  const broken = reps.filter((r) => r.outcome === "broken");
  const errored = reps.filter((r) => r.outcome === "error");
  const base = { experiment: result.experiment, runId: result.runId, by: "rules" as const };
  if (broken.length) {
    const counts = new Map<string, number>();
    for (const r of broken) for (const id of r.broken) counts.set(id, (counts.get(id) ?? 0) + 1);
    const rules = [...counts].map(([id, n]) => `${id} ${n}/${total}`).join(", ");
    const partial = broken.length < total ? "; not in every run, so it depends on timing: add a race or raise repeat to make it reliable" : "";
    const errors = errored.length ? `; ${errored.length} run(s) also errored (${firstLine(errored[0]!.error)})` : "";
    return { ...base, label: "bug", reason: `rules broke: ${rules}${partial}${errors}` };
  }
  if (errored.length === 0) return undefined;
  if (errored.every((r) => ENVIRONMENT.test(r.error ?? ""))) {
    return { ...base, label: "environment", reason: firstLine(errored[0]!.error) };
  }
  if (errored.length < total) {
    return { ...base, label: "flaky", reason: `${errored.length}/${total} runs errored, the others passed: ${firstLine(errored[0]!.error)}` };
  }
  const ruleError = /^rule ([\w-]+): (.*)/.exec(errored[0]!.error ?? "");
  if (ruleError) return { ...base, label: "outdated-test", reason: `rule ${ruleError[1]}'s SQL fails: ${ruleError[2]} (fix .windtunnel/rules.yaml)` };
  return undefined;
}

/** The experiment with no perturbations, race or webhook control (state set-up SQL stays), run once. */
export function controlOf(experiment: Experiment): Experiment {
  return {
    ...experiment,
    id: `${experiment.id}--control`,
    description: `${experiment.id} without perturbations (failure sorting)`,
    perturb: experiment.perturb.filter((p) => p.do === "sql"),
    race: undefined,
    webhooks: undefined,
    repeat: 1,
    file: undefined,
  };
}

async function afterControl(
  runner: Runner,
  result: ExperimentResult,
  experiment: Experiment,
  errors: FlowError[],
  control: ExperimentResult,
  options: TriageOptions,
): Promise<TriageEntry> {
  const base = { experiment: result.experiment, runId: result.runId };
  const first = errors[0];
  const [controlRep] = await repFiles(runner, control);
  const controlError = controlRep?.errors?.[0];

  if (control.reps.every((r) => r.outcome !== "error")) {
    // Only fails under the perturbation: the app's behaviour there, or the flow's expectation of it.
    const perturbed = describePerturbations(experiment);
    const question: Question = {
      kind: "triage",
      ask: `A flow finishes in a normal run but not under ${perturbed}. Is the app wrong, or does the flow expect something the app reasonably doesn't do under that condition?`,
      context: [
        `failed in every run at ${first?.tab ?? "?"}${first?.step ? ` / step ${first.step}` : ""}: ${first?.message ?? result.reps[0]?.error ?? "?"}`,
        ...(first?.page ? [`page ${first.page.path}${first.page.alerts.length ? `, alert: ${first.page.alerts.join(" | ")}` : ""}, shows: ${first.page.text.slice(0, 200)}`] : []),
        `the same flow without perturbations finished (run ${control.runId})`,
      ],
      options: {
        bug: "bug: the app leaves the user stuck or in a wrong state under this condition",
        "outdated-test": "outdated test: the app handled it acceptably (e.g. an error with a way to retry); the flow should accept that ending",
      },
    };
    return decided(base, question, await options.decider.decide(question), options, { kind: "triage", runId: result.runId, dir: result.dir });
  }

  if (controlError && ENVIRONMENT.test(controlError.message)) {
    return { ...base, label: "environment", reason: controlError.message, by: "rules" };
  }
  if (controlError?.locator && options.heal !== false) {
    return heal(runner, result, experiment, control, controlError, options);
  }
  const question = normalRunQuestion(controlError, control.reps[0]?.error);
  return decided(base, question, await options.decider.decide(question), options, { kind: "triage", runId: result.runId, dir: result.dir });
}

/** The flow fails without perturbations too: a broken app, an out-of-date flow, or the machine? */
function normalRunQuestion(error: FlowError | undefined, fallback: string | undefined, extra: string[] = []): Question {
  return {
    kind: "triage",
    ask: "A flow fails in every run, and also in a run without perturbations. Is the app broken, has the app changed so the flow no longer fits, or is it the machine?",
    context: [
      `error: ${error?.tab ?? "?"}${error?.step ? ` / step ${error.step}` : ""}: ${error?.message ?? fallback ?? "?"}`,
      ...(error?.page ? [`page ${error.page.path}${error.page.alerts.length ? `, alert: ${error.page.alerts.join(" | ")}` : ""}, shows: ${error.page.text.slice(0, 200)}`] : []),
      ...extra,
    ],
    options: {
      bug: "bug: the app fails on its normal path",
      "outdated-test": "outdated test: the flow no longer matches the app (moved page, changed wording)",
      environment: "environment: the machine, database or browser",
    },
  };
}

/** Rewrites the failing locator in the flow file, checks it with a run without perturbations, repeats for the next one. */
async function heal(
  runner: Runner,
  result: ExperimentResult,
  experiment: Experiment,
  control: ExperimentResult,
  failure: FlowError,
  options: TriageOptions,
): Promise<TriageEntry> {
  const base = { experiment: result.experiment, runId: result.runId };
  const files = await flowFiles(runner.project, experiment);
  const healed: Heal[] = [];
  const edits: { file: string; before: string }[] = [];
  let by: DecidedBy = "rules";
  let current = failure;
  let currentRun = control;
  for (let round = 0; round < MAX_HEALS; round++) {
    // Another experiment on the same flow already asked about this locator: wait for that answer.
    const open = (await options.decisions.open()).find(
      (d) => (d.payload as SelectorPayload).kind === "selector" && (d.payload as SelectorPayload).locator === current.locator!.locator && sameFiles((d.payload as SelectorPayload).files, files),
    );
    if (open) {
      return { ...base, reason: `same locator as decision ${open.id}: answering it heals this flow too; then re-run ${experiment.id}`, by: "agent", ...(healed.length ? { healed } : {}) };
    }
    const plan = await planHeal(runner, files, current, currentRun);
    if ("gone" in plan) {
      const [check] = await runner.run([controlOf(experiment)], { version: options.version, repeat: 1, trace: "off" });
      const next = (await repFiles(runner, check!))[0]?.errors?.[0];
      if (!next) break;
      if (next.locator?.locator === current.locator!.locator || !next.locator) {
        return { ...base, label: "outdated-test", reason: `${current.locator!.locator} is gone from the flow, which still fails without perturbations: ${firstLine(next.message)}`, by };
      }
      current = next;
      currentRun = check!;
      continue;
    }
    // Can't be healed by rewriting one call: whether the app or the flow is wrong is a judgement call.
    const judge = async (why: string) => {
      const snapshot = await readSnapshot(runner, currentRun, current);
      const texts = [...new Set((snapshot?.elements ?? []).filter((e) => ["heading", "alert", "status", "paragraph", "dialog"].includes(e.role) && e.name).map((e) => e.name.slice(0, 80)))].slice(0, 8);
      const question = normalRunQuestion(current, undefined, [`not healed: ${why}`, ...(texts.length ? [`the page says: ${texts.map((t) => JSON.stringify(t)).join(" · ")}`] : [])]);
      return decided(base, question, await options.decider.decide(question), options, { kind: "triage", runId: result.runId, dir: result.dir });
    };
    if ("stop" in plan) {
      if (healed.length) return { ...base, label: "outdated-test", reason: `healed ${healed.length} locator(s), then: ${plan.stop}`, by, healed };
      return judge(plan.stop);
    }
    const { question, candidates, matches, rules, target } = plan;
    const answer = await options.decider.decide(question, rules);
    if (!answer.choice) {
      const decision = await options.decisions.add({
        question,
        hint: rules && rules.confidence >= 0.3 ? question.options[rules.choice] : undefined,
        note: answer.note,
        freeForm: "Playwright code for the right element, e.g. page.getByRole(\"link\", { name: \"Checkout\" })",
        payload: { kind: "selector", experiment: experiment.id, runId: result.runId, dir: result.dir, step: current.step, locator: current.locator!.locator, files, ref: options.version?.ref, candidates: Object.fromEntries(candidates.map((c, i) => [`c${i + 1}`, c.code])) },
      });
      return { ...base, reason: `${healed.length ? `healed ${healed.length} locator(s); ` : ""}${question.ask}`, by: "agent", decision, ...(healed.length ? { healed } : {}) };
    }
    by = higher(by, answer.by);
    if (answer.choice === "none") {
      await restoreSource(edits.reverse());
      if (healed.length) {
        return { ...base, label: "outdated-test", reason: `${healed.length} locator(s) could be healed, but then nothing on the page matched ${current.locator!.locator}, so every edit was put back`, by };
      }
      return judge(`nothing on ${current.page?.path ?? "the page"} matches ${current.locator!.locator} (${BY[answer.by]})`);
    }
    const code = answer.choice === "exact" ? withExact(target)! : candidates[Number(answer.choice.slice(1)) - 1]!.code;
    options.onProgress?.(`healing ${experiment.id}: ${current.locator!.locator} → ${code}`);
    const saved = await replaceInSource(matches, code);
    edits.push(...saved);
    const [check] = await runner.run([controlOf(experiment)], { version: options.version, repeat: 1, trace: "off" });
    const [rep] = await repFiles(runner, check!);
    const next = rep?.errors?.[0];
    // Still stuck at the same place, or failing some other way: put every edit back.
    if (next?.locator?.locator === current.locator!.locator || (next && !next.locator)) {
      await restoreSource(edits.reverse());
      return {
        ...base,
        label: "outdated-test",
        reason: `${current.locator!.locator} isn't on ${current.page?.path ?? "the page"} in a normal run; tried ${code}, which didn't fix it (${firstLine(next.message)}), so the flow is unchanged`,
        by,
      };
    }
    for (const s of saved) {
      const lines = matches.filter((m) => m.file === s.file).map((m) => m.line);
      healed.push({ file: relative(runner.project.root, s.file), lines, from: current.locator!.locator, to: code });
    }
    if (!next) break;
    current = next;
    currentRun = check!;
  }
  options.onProgress?.(`re-running ${experiment.id} after healing`);
  const [rerun] = await runner.run([experiment], { version: options.version, repeat: result.reps.length / result.variants.length, trace: "failures" });
  return {
    ...base,
    label: "outdated-test",
    reason: healed.length
      ? "the flow's locators no longer matched the app; a run without perturbations now finishes"
      : "its flow was healed for another experiment above; a run without perturbations now finishes",
    by,
    ...(healed.length ? { healed } : {}),
    rerun,
  };
}

type HealPlan =
  | { stop: string }
  /** The locator is no longer in the flow (healed for another experiment just now, or edited). */
  | { gone: true }
  | { question: Question; candidates: Candidate[]; matches: SourceMatch[]; rules?: { choice: string; confidence: number }; target: NonNullable<ReturnType<typeof parseLocator>>["target"] & object };

async function planHeal(runner: Runner, files: string[], failure: FlowError, run: ExperimentResult): Promise<HealPlan> {
  const located = failure.locator!;
  const parsed = parseLocator(located.locator);
  if (!parsed?.target) return { stop: `can't read the locator ${located.locator}` };
  if (parsed.composite) return { stop: `${located.locator} combines locators with or()/and(); fix it by hand` };
  const matches = await findInSource(files, parsed.target);
  const literal = matches.filter((m) => !m.dynamic);
  const where = (list: SourceMatch[]) => list.map((m) => `${relative(runner.project.root, m.file)}:${m.line}`).join(", ");
  if (matches.length === 0) return { gone: true };
  if (literal.length === 0) return { stop: `${located.locator} is built from variables at ${where(matches)}; check the values (e.g. params) by hand` };
  const snapshot = await readSnapshot(runner, run, failure);
  if (!snapshot) return { stop: `${located.locator} failed, and the page could not be read` };

  const candidates = rankCandidates(parsed.target, snapshot, located.action);
  const exact = located.matched ? withExact(parsed.target) : undefined;
  const pick = rulesPick(candidates, { action: located.action, matched: located.matched, call: parsed.target });
  const options: Record<string, string> = {};
  candidates.forEach((c, i) => (options[`c${i + 1}`] = candidateLabel(c)));
  if (exact && pick && pick.confidence >= 0.9) options.exact = `${exact}: only the element named exactly that`;
  options.none = "none of these: it isn't on the page (the app changed what users see, or is broken)";
  const what = located.matched ? `matched ${located.matched} elements` : "found nothing";
  const ask = ACTS.has(located.action)
    ? `In a run without perturbations, the flow's ${located.action} on ${located.locator} (step ${failure.step ?? "?"}) ${what} on ${snapshot.path}. Which element did it mean?`
    : `In a run without perturbations, the flow waited to see ${located.locator} (step ${failure.step ?? "?"}) and it ${what} on ${snapshot.path}. This checks what the app shows: pick an element only if it says the same thing in other words; if the page shows a different outcome (an error, another state), answer none.`;
  const question: Question = {
    kind: "selector",
    ask,
    context: [
      `flow code: ${literal.map((m) => m.text).join(" | ")} (${where(literal)})`,
      ...(failure.page?.alerts.length ? [`alerts: ${failure.page.alerts.join(" | ")}`] : []),
      `page ${snapshot.path}${snapshot.title ? ` "${snapshot.title}"` : ""}, its headings and controls:`,
      ...snapshot.elements
        .filter((e) => e.role === "heading" || CONTROL_ROLES.has(e.role) || e.clickable || (e.role === "alert" && e.name))
        .slice(0, 20)
        .map((e) => `  ${describeElement(e)}${e.near && e.role !== "heading" ? ` (under "${e.near.slice(0, 40)}")` : ""}`),
    ],
    options,
  };
  const rules = pick ? { choice: options.exact ? "exact" : `c${pick.index + 1}`, confidence: pick.confidence } : undefined;
  return { question, candidates, matches: literal, rules, target: parsed.target };
}

async function readSnapshot(runner: Runner, run: ExperimentResult, failure: FlowError): Promise<PageSnapshot | undefined> {
  if (!failure.snapshot) return undefined;
  for (const rep of run.reps) {
    const file = join(runner.store.repDir(run.dir, rep.rep), failure.snapshot);
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text) return JSON.parse(text) as PageSnapshot;
  }
  return undefined;
}

async function decided(
  base: { experiment: string; runId: string },
  question: Question,
  answer: Awaited<ReturnType<Decider["decide"]>>,
  options: TriageOptions,
  payload: { kind: "triage"; runId: string; dir: string },
): Promise<TriageEntry> {
  if (answer.choice) {
    return { ...base, label: answer.choice as FailureLabel, reason: `${question.options[answer.choice]} (${question.context[0]})`, by: answer.by };
  }
  const decision = await options.decisions.add({ question, note: answer.note, payload });
  return { ...base, reason: question.ask, by: "agent", decision };
}

async function repFiles(runner: Runner, result: ExperimentResult): Promise<RepFile[]> {
  const out: RepFile[] = [];
  for (const rep of result.reps) {
    const text = await readFile(join(runner.store.repDir(result.dir, rep.rep), "result.json"), "utf8").catch(() => undefined);
    out.push(text ? (JSON.parse(text) as RepFile) : { rep: rep.rep, outcome: rep.outcome, error: rep.error });
  }
  return out;
}

async function writeTriage(dir: string, entry: TriageEntry): Promise<void> {
  const { rerun, decision, ...rest } = entry;
  await writeFile(
    join(dir, "triage.json"),
    `${JSON.stringify({ ...rest, ...(rerun ? { rerun: { runId: rerun.runId, outcome: rerun.outcome } } : {}), ...(decision ? { decision: decision.id } : {}) }, null, 2)}\n`,
  ).catch(() => undefined);
}

function describePerturbations(e: Experiment): string {
  const parts = e.perturb.filter((p) => p.do !== "sql").map((p) => `${p.do}${"request" in p ? ` ${p.request}` : ""}${p.step ? ` at ${p.step}` : ""}`);
  if (e.race) parts.push(`a race on ${e.race.request}`);
  if (e.webhooks) parts.push(`webhooks ${JSON.stringify(e.webhooks)}`);
  return parts.join(", ") || "its conditions";
}

const LEVELS: DecidedBy[] = ["rules", "jev", "spark", "agent"];

/** The more expensive of two levels. */
function higher(a: DecidedBy, b: DecidedBy): DecidedBy {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

function firstLine(text: string | undefined): string {
  return (text ?? "?").split("\n")[0]!.slice(0, 300);
}

const LABELS: Record<FailureLabel, string> = { bug: "bug", flaky: "flaky", "outdated-test": "outdated test", environment: "environment" };
const BY: Record<DecidedBy, string> = { rules: "rules", spark: "Muse Spark", jev: "Jev", agent: "you" };

/** Results as they stand after sorting: a healed experiment's re-run replaces its first run. */
export function afterTriage(results: ExperimentResult[], entries: TriageEntry[]): ExperimentResult[] {
  return results.map((r) => entries.find((e) => e.runId === r.runId)?.rerun ?? r);
}

/** The sorting as text, for the run's tool result. `chain` says who decides: `rules, then you`. */
export function formatTriage(entries: TriageEntry[], chain: string): string {
  if (entries.length === 0) return "";
  const width = Math.max(10, ...entries.map((e) => e.experiment.length));
  const lines = [`Failure sorting (decided by ${chain}):`];
  for (const e of entries) {
    const label = e.label ? LABELS[e.label] : "for you";
    lines.push(`  ${e.experiment.padEnd(width)}  ${label.padEnd(13)}  ${e.reason}${e.label ? ` [by ${BY[e.by]}]` : ""}`);
    for (const h of e.healed ?? []) lines.push(`  ${"".padEnd(width)}  ${"".padEnd(13)}  healed ${h.file}:${h.lines.join(",")}  ${h.from} → ${h.to}`);
    if (e.rerun) {
      const r = e.rerun;
      const ok = r.reps.filter((x) => x.outcome === "ok").length;
      const orderings = r.variants.length > 1 ? `, ${r.variants.length} orderings` : "";
      const why = r.outcome !== "pass" ? `: ${r.reps.find((x) => x.error)?.error ?? r.reps.find((x) => x.broken.length)?.broken.join(", ") ?? ""}` : "";
      lines.push(`  ${"".padEnd(width)}  ${"".padEnd(13)}  re-ran the whole experiment: ${r.outcome.toUpperCase()} ${ok}/${r.reps.length} runs ok${orderings} (run ${r.runId}${why}; first run ${e.runId})`);
    }
  }
  const pending = entries.filter((e) => e.decision);
  if (pending.length) lines.push("", ...pending.map((e) => formatDecision(e.decision!)));
  return lines.join("\n");
}

// ---- Answers from the agent ----

interface SelectorPayload {
  kind: "selector";
  experiment: string;
  runId: string;
  dir: string;
  step?: string;
  locator: string;
  /** The flow's files when it was asked. */
  files?: string[];
  ref?: string;
  candidates: Record<string, string>;
}

function sameFiles(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((f) => b.includes(f));
}

interface TriagePayload {
  kind: "triage";
  runId: string;
  dir: string;
}

/** Applies the agent's answer to a pending decision; returns what happened. */
export async function answerDecision(runner: Runner, store: DecisionStore, id: string, answer: string, experiments: Experiment[]): Promise<string> {
  const decision = await store.get(id);
  if (decision.answered) return `decision ${id} was already answered (${decision.answered.answer}): ${decision.answered.result}`;
  const payload = decision.payload as SelectorPayload | TriagePayload;
  const choice = answer.trim();
  let result: string;
  if (payload.kind === "triage") {
    if (!(choice in decision.question.options)) throw new Error(`answer one of: ${Object.keys(decision.question.options).join(", ")}`);
    const file = join(payload.dir, "triage.json");
    const old = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, unknown>;
    await writeFile(file, `${JSON.stringify({ ...old, label: choice, by: "agent", decision: id }, null, 2)}\n`);
    result = `run ${payload.runId} marked ${LABELS[choice as FailureLabel] ?? choice}`;
  } else {
    result = await applySelector(runner, payload, choice, decision.question.options, experiments);
  }
  decision.answered = { at: new Date().toISOString(), answer: choice, result };
  await store.save(decision);
  return result;
}

async function applySelector(runner: Runner, payload: SelectorPayload, choice: string, options: Record<string, string>, experiments: Experiment[]): Promise<string> {
  const experiment = experiments.find((e) => e.id === payload.experiment);
  if (!experiment) throw new Error(`experiment ${payload.experiment} no longer exists`);
  if (choice === "none") return `left ${payload.locator} as it is: the flow or the app needs a change by hand`;
  const parsed = parseLocator(payload.locator);
  if (!parsed?.target) throw new Error(`can't read ${payload.locator}`);
  let code = payload.candidates[choice] ?? (choice === "exact" ? withExact(parsed.target) : undefined);
  if (!code) {
    if (choice in options) throw new Error(`option ${choice} has no code to write`);
    // Free-form Playwright code: `page.getByRole(…)` or `getByRole(…)`.
    const own = parseLocator(choice.replace(/^page\./, "").replace(/;$/, ""));
    if (!own?.target) throw new Error(`answer an option (${Object.keys(options).join(", ")}) or Playwright code such as page.getByRole("button", { name: "Pay" })`);
    code = choice.replace(/^page\./, "").replace(/;$/, "");
  }
  const files = await flowFiles(runner.project, experiment);
  const matches = (await findInSource(files, parsed.target)).filter((m) => !m.dynamic);
  if (matches.length === 0) return `${payload.locator} is no longer in the flow's files: nothing changed`;
  const saved = await replaceInSource(matches, code);
  const [check] = await runner.run([controlOf(experiment)], { version: payload.ref ? { ref: payload.ref } : {}, repeat: 1, trace: "off" });
  const where = matches.map((m) => `${relative(runner.project.root, m.file)}:${m.line}`).join(", ");
  const [rep] = await repFiles(runner, check!);
  const next = rep?.errors?.[0];
  if (!next && !rep?.error) return `wrote ${code} at ${where}; a run without perturbations now finishes (run ${check!.runId}). Re-run ${experiment.id}.`;
  if (!next || next.step === payload.step) {
    await restoreSource(saved);
    return `put the original back: with ${code} the flow still fails at step ${payload.step ?? "?"} (${next?.message ?? rep?.error}; evidence ${check!.runId})`;
  }
  return `wrote ${code} at ${where}; a run without perturbations now gets past step ${payload.step ?? "?"} but fails at ${next.step ?? "?"}: ${next.message} (evidence ${check!.runId})`;
}

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ConfigError } from "../config.ts";
import { findScenario, probePoints, swiftFiles } from "../mac/swift.ts";
import type { Project } from "../project.ts";
import type { Rule } from "../rules.ts";
import { LOGIN_FLOW, loadFlow } from "./flows.ts";
import { DURATION, matchesLogged, parseDuration, parseRequestPattern, REQUEST_PATTERN } from "./match.ts";

export const EXPERIMENTS_DIR = "experiments";
const ID = /^[a-z0-9][a-z0-9-]*$/;

const Duration = z
  .union([z.number().int().nonnegative(), z.string().regex(DURATION, 'use a number of ms or e.g. "500ms", "3s", "25h"')])
  .transform(parseDuration);
const Request = z.string().regex(REQUEST_PATTERN, 'expected "METHOD /path", e.g. "POST /api/orders", "invoke <command>" or "point <name>"');
const Step = z.string().min(1);
/** Limits a perturbation to one tab (`alice`, `bob`, `alice#2`); default: every tab. */
const Tab = z.string().optional();
/** How many matching requests to affect: the first N, or "all". */
const Count = z.union([z.number().int().positive(), z.literal("all")]).default(1);

/** `point: writer.append` is short for `request: point writer.append`: a Swift app's probe point. */
function pointAsRequest(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("point" in value) || "request" in value) return value;
  const { point, ...rest } = value as { point: unknown };
  return typeof point === "string" ? { ...rest, request: `point ${point}` } : value;
}

const Perturbation = z.preprocess(pointAsRequest, z.discriminatedUnion("do", [
  // Network: applied to matching requests from the browser.
  z.strictObject({ do: z.literal("delay"), request: Request, ms: Duration, step: Step.optional(), tab: Tab, count: Count }),
  z.strictObject({
    do: z.literal("fail"),
    request: Request,
    status: z.number().int().min(400).max(599).default(503),
    /** Answer only after this long (a slow server that gives up). */
    after: Duration.optional(),
    step: Step.optional(),
    tab: Tab,
    count: Count,
  }),
  z.strictObject({ do: z.literal("lose-response"), request: Request, step: Step.optional(), tab: Tab, count: Count }),
  z.strictObject({ do: z.literal("duplicate"), request: Request, step: Step.optional(), tab: Tab, count: Count }),
  // Probe points (Swift Mac apps): the task reaching the point is cancelled there, and goes on to find out.
  z.strictObject({ do: z.literal("cancel"), request: Request, step: Step.optional(), tab: Tab, count: Count }),
  // Sends the same request again with another user's session, after the app answered the first.
  z.strictObject({
    do: z.literal("replay-as"),
    request: Request,
    user: z.string().min(1),
    step: Step.optional(),
    tab: Tab,
    count: Count,
  }),
  // Browser: applied to a step.
  z.strictObject({ do: z.literal("double-submit"), step: Step, tab: Tab }),
  z.strictObject({ do: z.literal("repeat"), step: Step, times: z.number().int().min(1).max(5).default(1), tab: Tab }),
  z.strictObject({ do: z.literal("refresh"), step: Step, when: z.enum(["during", "after"]).default("during"), tab: Tab }),
  z.strictObject({ do: z.literal("back-resubmit"), step: Step, tab: Tab }),
  z.strictObject({ do: z.literal("expire-session"), step: Step, cookie: z.string().optional(), tab: Tab }),
  z.strictObject({ do: z.literal("advance-clock"), step: Step, by: Duration, tab: Tab }),
  z.strictObject({ do: z.literal("second-tab"), step: Step, tab: Tab }),
  // Phone: applied to a step. `during`: while the step's first request is in flight; `after`: once it has finished.
  z.strictObject({ do: z.literal("kill-app"), step: Step, when: z.enum(["during", "after"]).default("during"), tab: Tab }),
  z.strictObject({
    do: z.literal("background"),
    step: Step,
    when: z.enum(["during", "after"]).default("during"),
    /** How long the app stays in the background. */
    for: Duration.default(1_000),
    tab: Tab,
  }),
  z.strictObject({ do: z.literal("rotate"), step: Step, when: z.enum(["during", "after"]).default("during"), tab: Tab }),
  z.strictObject({ do: z.literal("offline"), step: Step, tab: Tab }),
  // iOS: a push notification, as Apple's push service delivers it (`aps` and the app's own keys).
  z.strictObject({
    do: z.literal("push"),
    step: Step,
    when: z.enum(["during", "after"]).default("during"),
    payload: z.record(z.string(), z.unknown()).default({ aps: { alert: "Wind Tunnel" } }),
    tab: Tab,
  }),
  // App state: runs once, before the first tab reaches the step.
  z.strictObject({ do: z.literal("sql"), step: Step, sql: z.string().min(1), tab: Tab }),
]));

const RaceOrder = z.union([
  z.enum(["together", "arrival", "reverse", "each"]),
  z.array(z.union([z.string(), z.number().int().positive()])).min(2),
]);

const Race = z.preprocess(pointAsRequest, z.strictObject({
  /** Requests (or probe points) to hold at the barrier. */
  request: Request,
  step: Step.optional(),
  /** How many requests to gather before releasing (default: the number of tabs, at least 2). */
  count: z.number().int().min(2).max(6).optional(),
  /**
   * `together`: release all at once. `arrival` / `reverse`: one at a time, each after the
   * previous response. A list orders by tab name or arrival number. `each`: every ordering,
   * each as its own variant.
   */
  order: RaceOrder.default("together"),
  /** Release whatever has arrived after this long. */
  timeout: Duration.default(2_000),
}));

const WEBHOOK_SHORTHANDS: Record<string, object> = {
  duplicate: { times: 2 },
  early: { timing: "early" },
  late: { timing: "late" },
  "out-of-order": { timing: "late", order: "reverse" },
};

const Webhooks = z.preprocess(
  (value) => {
    const expand = (v: unknown) => (typeof v === "string" ? (WEBHOOK_SHORTHANDS[v] ?? v) : v);
    return Array.isArray(value) ? Object.assign({}, ...value.map(expand)) : expand(value);
  },
  z.strictObject({
    /** `early`: before the app gets the payment API's answer. `late`: after the step that caused it has finished. */
    timing: z.enum(["normal", "early", "late"]).default("normal"),
    /** Deliveries per event; 2 or more sends duplicates. */
    times: z.number().int().min(1).max(5).default(1),
    /** For late events: deliver in the order they were sent, or newest first. */
    order: z.enum(["sent", "reverse"]).default("sent"),
    /** Extra wait before each delivery (normal: after the charge; late: after the step). */
    delay: Duration.optional(),
  }).refine((w) => !(w.timing === "early" && w.delay !== undefined), { message: "early webhooks can't also have a delay" }),
);

export const ExperimentSchema = z.strictObject({
  id: z.string().regex(ID).optional(),
  description: z.string().optional(),
  /** The flow that drives the app (`.windtunnel/flows/<name>.ts`). */
  flow: z.string().optional(),
  /**
   * For a Swift Mac app (app.kind: mac): the XCTest method that drives its code,
   * `RecorderScenarios/testStopWhileWriting`, instead of a flow.
   */
  scenario: z.string().regex(/^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/, "Class/testMethod (or Module.Class/testMethod)").optional(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** One tab per entry, run at the same time. Repeating a user opens another tab in the same session. */
  users: z.array(z.string()).min(1).max(6).optional(),
  perturb: z.array(Perturbation).default([]),
  race: Race.optional(),
  webhooks: Webhooks.optional(),
  /** Browser clock start time (ISO). Timers keep running from there. */
  clock: z.union([z.iso.datetime({ offset: true }), z.iso.date()]).optional(),
  rules: z.union([z.literal("all"), z.array(z.string()).min(1)]).default("all"),
  repeat: z.number().int().min(1).max(100).default(3),
  /** Limit for one run of the flow. */
  timeout: Duration.default(60_000),
  /**
   * What the agent found once a rule broke and it read the code behind it: why the app breaks, what
   * would fix it, and where (`path:line`). Replay shows it with the rule that broke.
   */
  finding: z
    .strictObject({
      cause: z.string().min(1),
      fix: z.string().min(1).optional(),
      code: z.array(z.string().min(1)).default([]),
    })
    .optional(),
}).refine((e) => (e.flow === undefined) !== (e.scenario === undefined), { message: "an experiment has a flow, or (for a Swift Mac app) a scenario" });

export type Experiment = z.output<typeof ExperimentSchema> & { id: string; file?: string };
export type Perturbation = z.output<typeof Perturbation>;
export type NetworkPerturbation = Extract<Perturbation, { request: string }>;
export type BrowserPerturbation = Exclude<Perturbation, { request: string }>;
export type RaceSpec = z.output<typeof Race>;
export type WebhookSpec = z.output<typeof Webhooks>;
export type RaceOrder = "together" | "arrival" | "reverse" | (string | number)[];

export interface Variant {
  /** `default`, or with `race.order: each` the ordering (`together`, `alice,bob`, `2,1`). */
  name: string;
  order?: RaceOrder;
}

export function isNetworkPerturbation(p: Perturbation): p is NetworkPerturbation {
  return "request" in p;
}

/** Perturbations only a phone has: its app can be killed, sent away, turned, cut off, notified. */
export const PHONE_PERTURBATIONS = new Set(["kill-app", "background", "rotate", "offline", "push"]);
/** Of those, the ones only an iOS simulator does so far. */
export const IOS_PERTURBATIONS = new Set(["push"]);
/** Perturbations that need a browser: a page to reload or open twice, cookies, a fake clock, another user's session. */
export const BROWSER_PERTURBATIONS = new Set(["refresh", "second-tab", "expire-session", "advance-clock", "replay-as"]);
/** What a probe point can be made to do (Swift Mac apps): wait, throw, be cancelled. */
export const POINT_PERTURBATIONS = new Set(["delay", "fail", "cancel"]);

export function parseExperiment(text: string, source: string, fallbackId: string): Experiment {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`${source}: invalid YAML: ${(err as Error).message}`);
  }
  const result = ExperimentSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`${source}: invalid experiment\n${issues.join("\n")}`);
  }
  if (result.data.id && result.data.id !== fallbackId) {
    throw new ConfigError(`${source}: id "${result.data.id}" must match the file name ("${fallbackId}")`);
  }
  return { ...result.data, id: fallbackId, file: source };
}

/** Loads `.windtunnel/experiments/*.yaml`, or only the given ids. */
export async function loadExperiments(project: Project, ids: string[] = []): Promise<Experiment[]> {
  const dir = join(project.stateDir, EXPERIMENTS_DIR);
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  const byId = new Map(files.map((f) => [basename(f, extname(f)), f]));
  const wanted = ids.length > 0 ? ids : [...byId.keys()];
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    const known = [...byId.keys()].join(", ") || "none";
    throw new ConfigError(`unknown experiment(s): ${missing.join(", ")} (in ${dir}: ${known})`);
  }
  return Promise.all(
    wanted.map(async (id) => {
      const file = join(dir, byId.get(id)!);
      return parseExperiment(await readFile(file, "utf8"), file, id);
    }),
  );
}

/** Tab labels for an experiment: `alice`, `bob`, `alice#2` for a second tab of alice's session. */
export function tabLabels(users: string[]): { label: string; user: string }[] {
  const seen = new Map<string, number>();
  return users.map((user) => {
    const n = (seen.get(user) ?? 0) + 1;
    seen.set(user, n);
    return { label: n === 1 ? user : `${user}#${n}`, user };
  });
}

export function experimentUsers(experiment: Experiment, project: Project): string[] {
  return experiment.users ?? [Object.keys(project.config.users)[0] ?? "guest"];
}

/** Each race ordering to run. `each` expands to `together` plus every permutation. */
export function variantsOf(experiment: Experiment, users: string[]): Variant[] {
  const race = experiment.race;
  if (!race) return [{ name: "default" }];
  if (race.order !== "each") return [{ name: "default", order: race.order }];
  const labels = tabLabels(users).map((t) => t.label);
  const items: (string | number)[] =
    labels.length >= 2 ? labels : Array.from({ length: race.count ?? 2 }, (_, i) => i + 1);
  return [{ name: "together", order: "together" }, ...permutations(items).map((order) => ({ name: orderName(order), order }))];
}

function orderName(order: RaceOrder): string {
  return Array.isArray(order) ? order.join(",") : order;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/** Checks an experiment against the project: flow, steps, users, tabs and rules. */
export async function checkExperiment(experiment: Experiment, project: Project, rules: Rule[]): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const users = experimentUsers(experiment, project);
  const configured = Object.keys(project.config.users);
  for (const user of new Set(users)) {
    if (!project.config.users[user] && !(user === "guest" && configured.length === 0)) {
      errors.push(`unknown user "${user}" (config users: ${configured.join(", ") || "none"})`);
    }
  }
  const { kind } = project.config.app;
  const phone = kind === "android" || kind === "ios";
  const mac = kind === "mac";
  const isPoint = (request: string) => /^point\s/i.test(request.trim());
  for (const p of experiment.perturb) {
    if (mac) {
      if (!POINT_PERTURBATIONS.has(p.do)) errors.push(`${p.do}: not for Mac apps (their pressures are delay, fail and cancel at a probe point)`);
      else if ("request" in p && !isPoint(p.request)) errors.push(`${p.do} ${p.request}: a Mac app's calls are probe points (point: <name>)`);
    } else if (p.do === "cancel" || ("request" in p && isPoint(p.request))) {
      errors.push(`${p.do}${"request" in p ? ` ${p.request}` : ""}: probe points are for Swift Mac apps (app.kind: mac)`);
    } else if (phone && BROWSER_PERTURBATIONS.has(p.do)) {
      errors.push(`${p.do}: not for phone apps (${p.do === "refresh" ? "use kill-app or background" : "it needs a browser"})`);
    } else if (!phone && PHONE_PERTURBATIONS.has(p.do)) {
      errors.push(`${p.do}: only for phone apps (app.kind: android or ios)`);
    } else if (kind !== "ios" && IOS_PERTURBATIONS.has(p.do)) {
      errors.push(`${p.do}: only for iOS apps so far (app.kind: ios)`);
    }
  }
  if (experiment.race && mac !== isPoint(experiment.race.request)) {
    errors.push(mac ? `race on ${experiment.race.request}: a Mac app's races are on probe points (point: <name>)` : `race on ${experiment.race.request}: probe points are for Swift Mac apps (app.kind: mac)`);
  }
  if (phone && experiment.clock) errors.push("clock: phone apps run on the phone's own clock");
  if (mac && experiment.clock) errors.push("clock: a Mac app's scenario runs on the Mac's own clock");
  if (mac && experiment.users) errors.push("users: a Mac app's scenario is its own client; it has no users");
  for (const p of experiment.perturb) {
    if (p.do !== "replay-as") continue;
    if (!project.config.users[p.user]) {
      errors.push(`replay-as: unknown user "${p.user}" (config users: ${configured.join(", ") || "none"})`);
    } else if (users.includes(p.user) && users.length === 1) {
      warnings.push(`replay-as ${p.user}: the request is replayed as the same user who sent it`);
    }
  }

  let steps: string[] = [];
  if (mac) {
    if (experiment.flow !== undefined) errors.push("flow: a Swift Mac app's experiments run a scenario (scenario: Class/testMethod), not a flow");
    else steps = await checkScenario(experiment, project, errors, warnings);
  } else if (experiment.scenario !== undefined) {
    errors.push(`scenario: only Swift Mac apps (app.kind: mac) run XCTest scenarios; this app's experiments have a flow`);
  } else {
    try {
      const loaded = await loadFlow(project.stateDir, experiment.flow!);
      steps = loaded.steps;
      const login = await loadFlow(project.stateDir, LOGIN_FLOW).catch(() => undefined);
      for (const f of [loaded, ...(login ? [login] : [])]) {
        const surface = f.flow.surface ?? "page";
        if (phone && surface !== "phone") {
          errors.push(`flow "${f.name}" drives a page; a phone app's flows are \`export default phoneFlow(async ({ ui, step }) => …)\``);
        } else if (!phone && surface === "phone") {
          errors.push(`flow "${f.name}" is a phoneFlow, but app.kind is ${project.config.app.kind}`);
        }
      }
      if (login) steps.push(...login.steps);
      else if (experiment.perturb.some((p) => p.do === "replay-as")) {
        errors.push("replay-as: add .windtunnel/flows/login.ts to log the other user in");
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const referenced = [
    ...experiment.perturb.flatMap((p) => (p.step ? [p.step] : [])),
    ...(experiment.race?.step ? [experiment.race.step] : []),
  ];
  for (const step of new Set(referenced)) {
    if (steps.length > 0 && !steps.includes(step) && step !== "login") {
      errors.push(`step "${step}" is not in ${experiment.scenario ? `scenario ${experiment.scenario}` : `flow "${experiment.flow}"`} (steps: ${steps.join(", ")})`);
    }
  }

  // A Mac app's scenario is one client, its code: the `app` tab.
  const opened = mac ? [{ label: "app", user: "app" }] : tabLabels(users);
  const labels = opened.map((t) => t.label);
  // A second-tab perturbation opens `<user>#<n>` next to each tab it applies to.
  const forks = new Set<string>();
  for (const p of experiment.perturb) {
    if (p.do !== "second-tab") continue;
    for (const user of new Set(opened.filter((t) => !p.tab || t.label === p.tab).map((t) => t.user))) {
      forks.add(`${user}#${opened.filter((t) => t.user === user).length + 1}`);
    }
  }
  const known = [...labels, ...forks];
  const tabs = [...experiment.perturb.flatMap((p) => (p.tab ? [p.tab] : []))];
  if (Array.isArray(experiment.race?.order)) {
    for (const item of experiment.race.order) if (typeof item === "string") tabs.push(item);
  }
  for (const tab of new Set(tabs)) {
    if (!known.includes(tab)) errors.push(`unknown tab "${tab}" (tabs: ${known.join(", ")})`);
  }
  if (experiment.race && Array.isArray(experiment.race.order)) {
    const count = experiment.race.count ?? Math.max(2, labels.length);
    if (experiment.race.order.length !== count) {
      errors.push(`race.order lists ${experiment.race.order.length} requests but race.count is ${count}`);
    }
  }

  if (experiment.rules !== "all") {
    const known = new Set(rules.map((r) => r.id));
    for (const id of experiment.rules) if (!known.has(id)) errors.push(`unknown rule "${id}"`);
  } else if (rules.length === 0) {
    warnings.push("no rules in .windtunnel/rules.yaml: runs only check that the flow finishes");
  }
  if (experiment.webhooks && !project.config.mockPay) {
    errors.push("webhooks: set mockPay in windtunnel.config.yaml to control payment webhooks");
  }
  return { errors, warnings };
}

/**
 * Finds a Mac app's scenario in its package and returns its steps; probe points the experiment
 * names that the code doesn't have are warnings (a point may be in code the reader misses).
 */
async function checkScenario(experiment: Experiment, project: Project, errors: string[], warnings: string[]): Promise<string[]> {
  const dir = join(project.root, project.config.mac?.dir ?? ".");
  const xcode = project.config.mac?.project ? {} : undefined;
  const files = await swiftFiles(dir);
  const scenario = await findScenario(dir, experiment.scenario!, files, xcode);
  if (!scenario) {
    errors.push(`scenario ${experiment.scenario}: no such XCTest method in ${xcode ? `${dir}'s tests` : `${dir}/Tests`} (Class/testMethod)`);
    return [];
  }
  const points = await probePoints(dir, files);
  const requests = [...experiment.perturb.flatMap((p) => ("request" in p ? [p.request] : [])), ...(experiment.race ? [experiment.race.request] : [])];
  for (const request of new Set(requests.filter((r) => /^point\s/i.test(r.trim())))) {
    const pattern = parseRequestPattern(request);
    if (!points.some((p) => matchesLogged(pattern, "POINT", p.name))) {
      const known = [...new Set(points.map((p) => p.name))].join(", ") || "none";
      warnings.push(`${request}: no Probe.point in the code has that name (points: ${known})`);
    }
  }
  return scenario.steps;
}

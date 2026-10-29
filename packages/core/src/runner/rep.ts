import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { MockEvent, Tenant } from "@windtunnel/mock-pay";
import type { Browser, BrowserContext, Page, Request } from "playwright";
import type { FlowContext, TestUser } from "../flow-api.ts";
import type { BrowserPerturbation, Experiment, RaceOrder, Variant, WebhookSpec } from "./experiment.ts";
import { isNetworkPerturbation } from "./experiment.ts";
import type { LoadedFlow } from "./flows.ts";
import { type ActionCall, describeAction, instrumentPage } from "./instrument.ts";
import { Network, type RaceRecord, type RequestRecord } from "./network.ts";
import { type LocatorFailure, locatorFailure, snapshotPage } from "./snapshot.ts";
import { writeJson } from "./store.ts";
import { sleep, within } from "./time.ts";

export type TraceMode = "off" | "failures" | "on";

export interface StepRecord {
  tab: string;
  step: string;
  /** `repeat 1`, `resubmit`: a perturbation ran the step again. */
  attempt?: string;
  /** ms since the run started. */
  start: number;
  end: number;
  actions: { at: number; action: string }[];
  /** What the harness did around this step. */
  harness?: string[];
  /** The user the tab was logged in as, when the flow switched to another (`login("bob")`). */
  as?: string;
  error?: string;
  /** False when the network never went quiet after the step. */
  quiet: boolean;
  /** What the page said when the step ended (rules read it as `windtunnel_pages`). */
  seen?: { path: string; text: string };
}

export interface FlowError {
  tab: string;
  step?: string;
  message: string;
  /** What the page showed when the flow failed. */
  page?: PageState;
  /** The locator the failing action waited for, when it was one. */
  locator?: LocatorFailure;
  /** File in the run's folder with the page's controls and texts at the failure (a PageSnapshot). */
  snapshot?: string;
}

export interface PageState {
  path: string;
  /** Texts of role="alert" elements. */
  alerts: string[];
  /** The start of the visible text. */
  text: string;
}

export interface ConsoleRecord {
  tab: string;
  step?: string;
  at: number;
  type: string;
  text: string;
}

export interface WebhookRecord {
  event: string;
  type: string;
  charge: string;
  deliveries: { at: string; status: number | null; ms?: number; error?: string }[];
  /** The app path deliveries were posted to. */
  path?: string;
}

export interface RepInput {
  experiment: Experiment;
  variant: Variant;
  browser: Browser;
  baseUrl: string;
  /** The branch's database, for `sql` perturbations. */
  databaseUrl?: string;
  tenant?: Tenant;
  flow: LoadedFlow;
  login?: LoadedFlow;
  users: Record<string, TestUser>;
  tabs: { label: string; user: string }[];
  dir: string;
  trace: TraceMode;
}

interface Session {
  user: string;
  context: BrowserContext;
  tabs: Tab[];
  loggedInAs?: string;
  login?: Promise<void>;
}

interface Tab {
  label: string;
  user: TestUser;
  session: Session;
  page: Page;
  /** The instrumented page the flow sees. */
  view: Page;
  /** Opened by a second-tab perturbation: skips steps until this one. */
  skipUntil?: string;
  isFork: boolean;
  arrive?: () => Promise<void>;
  current?: { name: string; record: StepRecord; doubleSubmit: boolean; refreshPending: boolean };
  lastStep?: string;
  readonly stepName: string | undefined;
  takeRefresh(): boolean;
  reload(): Promise<void>;
}

/** One run of a step in one tab; `started` is ms since the run started. */
type StepInstance = { started: number };

const MAX_CONSOLE = 100;
/** Page text kept per step. */
const MAX_SEEN = 2_000;

/** One execution of an experiment's flow(s) against one branch. */
export class Rep {
  readonly steps: StepRecord[] = [];
  readonly errors: FlowError[] = [];
  readonly console: ConsoleRecord[] = [];
  readonly network: Network;
  timedOut = false;
  private readonly input: RepInput;
  /** When the run started; step and request times are ms since then. */
  readonly t0 = Date.now();
  private readonly sessions = new Map<string, Session>();
  private readonly tabs: Tab[] = [];
  private readonly tabByPage = new Map<Page, Tab>();
  private readonly running = new Set<Promise<void>>();
  private readonly active = new Set<StepInstance>();
  private readonly sqlDone = new Set<BrowserPerturbation>();
  private readonly webhooks: WebhookControl;
  /** Logged-in contexts of users that `replay-as` sends requests as. */
  private readonly replayers = new Map<string, Promise<BrowserContext>>();
  private closing = false;

  constructor(input: RepInput) {
    this.input = input;
    const { experiment } = input;
    const race = experiment.race;
    this.network = new Network({
      t0: this.t0,
      tabOf: (page) => this.tabByPage.get(page),
      perturbations: experiment.perturb.filter(isNetworkPerturbation),
      race: race && {
        ...race,
        count: race.count ?? Math.max(2, input.tabs.length),
        order: (input.variant.order ?? race.order) as RaceOrder,
      },
      replay: (user, request, original) => this.replayAs(user, request, original),
    });
    this.webhooks = new WebhookControl(input.tenant, experiment.webhooks, this.active, () => {
      // When the earliest request that could have made the charge (not a GET, still waiting) was sent.
      const pending = this.network.log.filter((r) => r.end === undefined && r.method !== "GET");
      return pending.length ? Math.min(...pending.map((r) => r.start)) : undefined;
    });
  }

  get race(): RaceRecord | undefined {
    return this.network.race;
  }

  get requests(): RequestRecord[] {
    return this.network.log;
  }

  /** Runs every tab's flow, then lets held webhooks and requests finish. */
  async execute(): Promise<void> {
    this.webhooks.setup();
    // Users that requests are replayed as log in before the flows start.
    for (const p of this.input.experiment.perturb) {
      if (p.do === "replay-as") await this.replayer(p.user).catch(() => undefined);
    }
    for (const { label, user } of this.input.tabs) {
      const session = await this.session(user);
      await this.addTab(session, label, await session.context.newPage(), false);
    }
    for (const tab of [...this.tabs]) this.runFlow(tab);
    await this.waitForFlows();
    await this.webhooks.finish();
    await this.network.drain();
  }

  webhookRecords(): WebhookRecord[] {
    return this.webhooks.records();
  }

  /** Parts of the experiment that never took effect in this run: a pass then proves less than it seems. */
  warnings(): string[] {
    const out: string[] = [];
    for (const p of this.network.unused()) out.push(`${p.do} ${p.request}${p.step ? ` (step ${p.step})` : ""}: no request matched`);
    const race = this.input.experiment.race;
    if (race) {
      const record = this.network.race;
      const count = race.count ?? Math.max(2, this.input.tabs.length);
      if (!record) out.push(`race on ${race.request}: no request matched, nothing was held`);
      else if (record.timedOut && record.arrived.length < count) {
        out.push(`race on ${race.request}: only ${record.arrived.length} of ${count} requests arrived; released after the timeout`);
      }
    }
    const spec = this.input.experiment.webhooks;
    if (spec && this.input.tenant) {
      const events = this.input.tenant.events.length;
      if (events === 0) out.push("webhooks: the app sent no payment, so no webhook was delivered");
      else if (spec.order === "reverse" && !this.webhooks.reordered) out.push("webhooks out-of-order: never more than one event at a time, nothing was reordered");
    }
    return out;
  }

  /** Stops tracing (saving traces when asked) and closes the browser contexts. */
  async close(keepTraces: boolean): Promise<string[]> {
    this.closing = true;
    const traces: string[] = [];
    for (const session of this.sessions.values()) {
      if (this.input.trace !== "off") {
        const path = keepTraces ? join(this.input.dir, `trace-${session.user}.zip`) : undefined;
        await session.context.tracing.stop(path ? { path } : undefined).then(
          () => path && traces.push(path),
          () => undefined,
        );
      }
      await session.context.close().catch(() => undefined);
    }
    for (const context of this.replayers.values()) await (await context.catch(() => undefined))?.close().catch(() => undefined);
    await Promise.allSettled([...this.running]);
    return traces;
  }

  now(): number {
    return Date.now() - this.t0;
  }

  private async session(user: string): Promise<Session> {
    let session = this.sessions.get(user);
    if (session) return session;
    const { experiment, browser, baseUrl, trace } = this.input;
    const context = await browser.newContext({
      baseURL: baseUrl,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    if (experiment.clock || experiment.perturb.some((p) => p.do === "advance-clock")) {
      await context.clock.install({ time: experiment.clock ? new Date(experiment.clock) : new Date() });
    }
    await this.network.attach(context);
    if (trace !== "off") await context.tracing.start({ snapshots: true, screenshots: true, title: experiment.id });
    session = { user, context, tabs: [] };
    this.sessions.set(user, session);
    return session;
  }

  /** A context logged in as `name`, used only to replay requests; it opens no tab. */
  private replayer(name: string): Promise<BrowserContext> {
    let context = this.replayers.get(name);
    if (!context) {
      context = this.logInReplayer(name);
      this.replayers.set(name, context);
    }
    return context;
  }

  private async logInReplayer(name: string): Promise<BrowserContext> {
    const { users, login, browser, baseUrl, experiment } = this.input;
    const user = users[name];
    if (!user) throw new Error(`unknown user "${name}"`);
    if (!login) throw new Error("add .windtunnel/flows/login.ts to log in");
    const context = await browser.newContext({ baseURL: baseUrl, locale: "en-US", timezoneId: "UTC", serviceWorkers: "block" });
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    try {
      await login.flow.run({
        page,
        step: (_name, action) => action(),
        login: () => Promise.reject(new Error("login() inside the login flow")),
        user,
        users,
        params: experiment.params,
        baseUrl,
        tab: `${name} (replay)`,
        clock: page.clock,
      });
    } catch (err) {
      await context.close().catch(() => undefined);
      throw new Error(`could not log in as ${name}: ${firstLine(err)}`);
    } finally {
      await page.close().catch(() => undefined);
    }
    return context;
  }

  /** Sends a request again with another user's session (`replay-as`) and logs it. */
  private async replayAs(user: string, request: Request, original: RequestRecord): Promise<RequestRecord> {
    const context = await this.replayer(user);
    const record = this.network.external({
      tab: `${user} (replay)`,
      user,
      step: original.step,
      method: original.method,
      url: original.url,
      type: "fetch",
      start: this.now(),
      harness: [`request ${original.id} from ${original.tab}, sent again with ${user}'s session`],
    });
    try {
      const headers = Object.fromEntries(
        Object.entries(request.headers()).filter(([name]) => name === "content-type" || name === "accept"),
      );
      const response = await context.request.fetch(new URL(original.url, this.input.baseUrl).href, {
        method: original.method,
        headers,
        data: request.postDataBuffer() ?? undefined,
        maxRedirects: 0,
        failOnStatusCode: false,
        timeout: 15_000,
      });
      record.response = this.now();
      record.status = response.status();
      await response.body().catch(() => undefined);
    } catch (err) {
      record.failure = firstLine(err);
    }
    record.end = this.now();
    return record;
  }

  private async addTab(session: Session, label: string, page: Page, isFork: boolean, skipUntil?: string): Promise<Tab> {
    const user = this.input.users[session.user] ?? { name: session.user, email: "", password: "" };
    const tab: Tab = {
      label,
      user,
      session,
      page,
      view: page,
      isFork,
      skipUntil,
      get stepName() {
        return this.current?.name;
      },
      takeRefresh() {
        if (!this.current?.refreshPending) return false;
        this.current.refreshPending = false;
        this.current.record.harness = [...(this.current.record.harness ?? []), "page refreshed while a request was in flight"];
        return true;
      },
      reload: async () => {
        await page.reload().catch(() => undefined);
      },
    };
    tab.view = instrumentPage(page, (call) => this.onAction(tab, call));
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") this.log(tab, msg.type(), msg.text());
    });
    page.on("pageerror", (err) => this.log(tab, "pageerror", err.message));
    session.tabs.push(tab);
    this.tabs.push(tab);
    this.tabByPage.set(page, tab);
    return tab;
  }

  private log(tab: Tab, type: string, text: string): void {
    if (this.console.length >= MAX_CONSOLE) return;
    this.console.push({ tab: tab.label, step: tab.stepName, at: this.now(), type, text: text.slice(0, 500) });
  }

  private async onAction(tab: Tab, call: ActionCall): Promise<unknown> {
    const current = tab.current;
    current?.record.actions.push({ at: this.now(), action: describeAction(call) });
    if (current?.doubleSubmit) {
      if (call.method === "click") {
        const args = [...call.args];
        args[call.optionsIndex] = { ...((args[call.optionsIndex] as object | undefined) ?? {}), clickCount: 2 };
        current.record.harness = [...(current.record.harness ?? []), "double-clicked"];
        return call.invoke(args);
      }
      if (call.method === "press" || call.method === "tap") {
        current.record.harness = [...(current.record.harness ?? []), `${call.method} twice`];
        await call.invoke();
        return call.invoke();
      }
    }
    return call.invoke();
  }

  private contextFor(tab: Tab): FlowContext {
    const { experiment, users, baseUrl } = this.input;
    return {
      page: tab.view,
      step: (name, action) => this.step(tab, name, action),
      login: (user) => this.login(tab, user),
      user: tab.user,
      users,
      params: experiment.params,
      baseUrl,
      tab: tab.label,
      clock: tab.page.clock,
    };
  }

  private runFlow(tab: Tab): Promise<void> {
    const run = (async () => {
      try {
        await this.input.flow.flow.run(this.contextFor(tab));
      } catch (err) {
        if (this.closing) return;
        const page = await pageState(tab.page);
        const locator = locatorFailure((err as Error)?.message ?? "");
        const snapshot = await this.capture(tab);
        this.errors.push({
          tab: tab.label,
          step: tab.lastStep,
          message: firstLine(err),
          ...(page ? { page } : {}),
          ...(locator ? { locator } : {}),
          ...(snapshot ? { snapshot } : {}),
        });
      }
    })();
    this.running.add(run);
    return run;
  }

  private async waitForFlows(): Promise<void> {
    const deadline = Date.now() + this.input.experiment.timeout;
    for (;;) {
      const pending = [...this.running];
      const done = await within(Promise.allSettled(pending).then(() => true), deadline - Date.now());
      if (!done) {
        this.timedOut = true;
        this.errors.push({ tab: "*", message: `timed out after ${this.input.experiment.timeout} ms` });
        for (const tab of this.tabs) await this.capture(tab);
        return;
      }
      if (this.running.size === pending.length) return;
    }
  }

  /** A screenshot and a snapshot of the tab's page; returns the snapshot's file name. */
  private async capture(tab: Tab): Promise<string | undefined> {
    const dir = join(this.input.dir, "screens");
    const name = tab.label.replace(/[^\w-]/g, "_");
    await mkdir(dir, { recursive: true });
    await tab.page.screenshot({ path: join(dir, `${name}.jpg`), type: "jpeg", quality: 60, timeout: 3_000 }).catch(() => undefined);
    const snapshot = await snapshotPage(tab.page);
    if (!snapshot) return undefined;
    await writeJson(join(this.input.dir, `snapshot-${name}.json`), snapshot);
    return `snapshot-${name}.json`;
  }

  private login(tab: Tab, name?: string): Promise<void> {
    const userName = name ?? tab.user.name;
    const user = this.input.users[userName];
    if (!user) return Promise.reject(new Error(`login: unknown user "${userName}"`));
    const loginFlow = this.input.login;
    if (!loginFlow) return Promise.reject(new Error("login(): add .windtunnel/flows/login.ts to log in"));
    const session = tab.session;
    if (session.loggedInAs === userName && session.login) return session.login;
    session.loggedInAs = userName;
    const run = () => loginFlow.flow.run({ ...this.contextFor(tab), user, step: (_name, action) => action() });
    session.login = tab.current ? run() : this.step(tab, "login", run);
    return session.login;
  }

  private perturbationsFor(tab: Tab, step: string): BrowserPerturbation[] {
    return this.input.experiment.perturb.filter(
      (p): p is BrowserPerturbation =>
        !isNetworkPerturbation(p) && p.step === step && (!p.tab || p.tab === tab.label),
    );
  }

  private async step<T>(tab: Tab, name: string, action: () => Promise<T>): Promise<T> {
    if (tab.skipUntil !== undefined) {
      if (name !== tab.skipUntil) return undefined as T;
      tab.skipUntil = undefined;
      await tab.arrive?.();
    }
    // A step inside a step is part of the outer one.
    if (tab.current) return action();

    // Late webhooks wait for the whole step, retries included.
    const instance: StepInstance = { started: this.now() };
    this.active.add(instance);
    try {
      return await this.runStep(tab, name, action);
    } finally {
      this.active.delete(instance);
      this.webhooks.stepFinished(instance);
    }
  }

  private async runStep<T>(tab: Tab, name: string, action: () => Promise<T>): Promise<T> {
    const perturbations = this.perturbationsFor(tab, name);
    const notes: string[] = [];
    for (const p of perturbations) {
      if (p.do === "expire-session") {
        await tab.session.context.clearCookies(p.cookie ? { name: p.cookie } : undefined);
        notes.push(p.cookie ? `cookie ${p.cookie} cleared` : "session cookies cleared");
      } else if (p.do === "advance-clock") {
        await tab.session.context.clock.fastForward(p.by);
        notes.push(`clock advanced ${p.by} ms`);
      } else if (p.do === "sql" && !this.sqlDone.has(p)) {
        this.sqlDone.add(p);
        const rows = await runSql(this.input.databaseUrl, p.sql);
        notes.push(`ran SQL (${rows} row(s)): ${p.sql.replace(/\s+/g, " ").trim()}`);
      } else if (p.do === "second-tab" && !tab.isFork) {
        const fork = await this.fork(tab, name);
        notes.push(`opened a second tab (${fork.label}) at ${pathOf(tab.page.url())}`);
      }
    }
    let result = await this.attempt(tab, name, undefined, action, {
      notes,
      doubleSubmit: perturbations.some((p) => p.do === "double-submit"),
      refreshDuring: perturbations.some((p) => p.do === "refresh" && p.when === "during"),
    });
    for (const p of perturbations) {
      if (p.do === "repeat") {
        for (let i = 1; i <= p.times; i++) {
          result = await this.attempt(tab, name, `repeat ${i}`, action, { notes: ["the user did the step again"] });
        }
      } else if (p.do === "back-resubmit") {
        result = await this.attempt(tab, name, "resubmit", action, {
          notes: ["went back, then did the step again"],
          before: async () => {
            await tab.page.goBack().catch(() => undefined);
            await this.network.quiet(tab.session.context);
          },
        });
      } else if (p.do === "refresh" && p.when === "after") {
        await tab.page.reload().catch(() => undefined);
        await this.network.quiet(tab.session.context);
        const last = this.steps.findLast((s) => s.tab === tab.label && s.step === name);
        if (last) last.harness = [...(last.harness ?? []), "page refreshed after the step"];
      }
    }
    return result;
  }

  private async attempt<T>(
    tab: Tab,
    name: string,
    attempt: string | undefined,
    action: () => Promise<T>,
    options: { notes?: string[]; doubleSubmit?: boolean; refreshDuring?: boolean; before?: () => Promise<void> },
  ): Promise<T> {
    const record: StepRecord = {
      tab: tab.label,
      step: name,
      ...(attempt ? { attempt } : {}),
      start: this.now(),
      end: 0,
      actions: [],
      ...(options.notes?.length ? { harness: [...options.notes] } : {}),
      quiet: true,
    };
    tab.current = { name, record, doubleSubmit: !!options.doubleSubmit, refreshPending: !!options.refreshDuring };
    tab.lastStep = name;
    if (options.refreshDuring) this.network.refreshArmed = true;
    try {
      await options.before?.();
      return await action();
    } catch (err) {
      record.error = firstLine(err);
      throw err;
    } finally {
      record.quiet = await this.network.quiet(tab.session.context);
      const seen = await pageText(tab.page);
      if (seen) record.seen = seen;
      if (tab.current.refreshPending) {
        record.harness = [...(record.harness ?? []), "refresh: the step sent no request to interrupt"];
      }
      tab.current = undefined;
      this.network.refreshArmed = this.tabs.some((t) => t.current?.refreshPending);
      if (tab.session.loggedInAs && tab.session.loggedInAs !== tab.user.name) record.as = tab.session.loggedInAs;
      record.end = this.now();
      this.steps.push(record);
    }
  }

  /** Opens a second tab of the same session on the current page; it runs the flow from `step` on. */
  private async fork(tab: Tab, step: string): Promise<Tab> {
    const session = tab.session;
    const page = await session.context.newPage();
    const label = `${session.user}#${session.tabs.length + 1}`;
    const fork = await this.addTab(session, label, page, true, step);
    const arrived = new Promise<void>((resolve) => {
      fork.arrive = async () => {
        await page.goto(tab.page.url()).catch(() => undefined);
        await this.network.quiet(session.context);
        resolve();
      };
    });
    const run = this.runFlow(fork);
    await within(Promise.race([arrived, run]), 15_000);
    return fork;
  }
}

/** Delivers payment webhooks early, late, out of order or more than once. */
class WebhookControl {
  private readonly tenant?: Tenant;
  private readonly spec?: WebhookSpec;
  private readonly active: Set<StepInstance>;
  private readonly chargeSentAt: () => number | undefined;
  private held: { event: MockEvent; waitFor: Set<StepInstance> }[] = [];
  /** Whether `out-of-order` ever had two or more events to reorder. */
  reordered = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    tenant: Tenant | undefined,
    spec: WebhookSpec | undefined,
    active: Set<StepInstance>,
    chargeSentAt: () => number | undefined,
  ) {
    this.tenant = tenant;
    this.spec = spec;
    this.active = active;
    this.chargeSentAt = chargeSentAt;
  }

  setup(): void {
    const { tenant, spec } = this;
    if (!tenant || !spec) return;
    const webhooks = spec.timing === "early" ? "early" : spec.timing === "late" ? "manual" : "auto";
    tenant.configure({
      webhooks,
      webhookTimes: spec.times,
      ...(spec.timing === "normal" && spec.delay !== undefined ? { webhookDelayMs: spec.delay } : {}),
    });
    if (spec.timing === "late") {
      // Held until the steps running when the paying request was sent have finished.
      tenant.onEvent = (event) => {
        // Steps that began after the paying request was sent (e.g. one waiting for the confirmation)
        // can't have made the charge, and may be waiting for this very webhook.
        const sent = this.chargeSentAt();
        this.held.push({ event, waitFor: new Set([...this.active].filter((s) => sent === undefined || s.started <= sent)) });
        setTimeout(() => this.flush(false), 0);
      };
    }
  }

  stepFinished(instance: StepInstance): void {
    if (this.held.length === 0) return;
    for (const h of this.held) h.waitFor.delete(instance);
    this.flush(false);
  }

  async finish(): Promise<void> {
    if (!this.tenant) return;
    this.flush(true);
    await this.chain;
    await this.tenant.settle();
  }

  records(): WebhookRecord[] {
    return (this.tenant?.events ?? []).map((e) => ({
      event: e.id,
      type: e.type,
      charge: e.data.object.id,
      deliveries: e.deliveries.map(({ at, status, error, durationMs }) => ({ at, status, ms: durationMs, ...(error ? { error } : {}) })),
    }));
  }

  private flush(all: boolean): void {
    const tenant = this.tenant;
    if (!tenant || !this.spec) return;
    const ready = this.held.filter((h) => all || h.waitFor.size === 0);
    if (ready.length === 0) return;
    this.held = this.held.filter((h) => !ready.includes(h));
    const batch = this.spec.order === "reverse" ? ready.reverse() : ready;
    const times = this.spec.times;
    if (batch.length > 1) this.reordered ||= this.spec.order === "reverse";
    const delay = this.spec.delay ?? 0;
    this.chain = this.chain.then(async () => {
      if (delay > 0) await sleep(delay);
      for (const h of batch) await tenant.deliver(h.event.id, times).catch(() => undefined);
    });
  }
}

function firstLine(err: unknown): string {
  return ((err as Error)?.message ?? String(err)).split("\n")[0]!.slice(0, 500);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Runs one statement against the branch's database; returns the affected row count. */
async function runSql(url: string | undefined, sql: string): Promise<number> {
  if (!url) throw new Error("sql perturbation: this run has no database");
  const client = new pg.Client({ connectionString: url, application_name: "windtunnel-perturb" });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query(sql)).rowCount ?? 0;
  } finally {
    await client.end();
  }
}

/** The page's path and visible text, whitespace collapsed. */
async function pageText(page: Page): Promise<{ path: string; text: string } | undefined> {
  if (page.isClosed()) return undefined;
  const text = await within(page.locator("body").innerText({ timeout: 1_000 }).catch(() => undefined), 1_500);
  if (typeof text !== "string") return undefined;
  return { path: pathOf(page.url()), text: text.replace(/\s+/g, " ").trim().slice(0, MAX_SEEN) };
}

/** Where the page is and what it says, for evidence when a flow fails. */
async function pageState(page: Page): Promise<PageState | undefined> {
  try {
    const path = new URL(page.url()).pathname;
    const alerts = (await within(page.getByRole("alert").allInnerTexts(), 1_000)) || [];
    const body = (await within(page.locator("body").innerText({ timeout: 1_000 }), 1_500)) || "";
    return { path, alerts: alerts.map((a) => a.trim()).filter(Boolean), text: body.replace(/\s+/g, " ").trim().slice(0, 300) };
  } catch {
    return undefined;
  }
}

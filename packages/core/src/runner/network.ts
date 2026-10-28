import type { BrowserContext, Page, Request, Route } from "playwright";
import type { NetworkPerturbation, RaceOrder, RaceSpec } from "./experiment.ts";
import { matchesRequest, parseRequestPattern, type RequestPattern } from "./match.ts";
import { sleep, within } from "./time.ts";

/** What a tab exposes to the network layer. */
export interface NetworkTab {
  label: string;
  /** The step running in this tab, if any. Requests are attributed to it. */
  readonly stepName: string | undefined;
  /** True once when the current step has "refresh during" armed. */
  takeRefresh(): boolean;
  reload(): Promise<void>;
}

export interface RequestRecord {
  id: number;
  tab: string;
  step?: string;
  method: string;
  /** Path and query. */
  url: string;
  type: string;
  /** ms since the run started. */
  start: number;
  /** When it reached the app, if later than `start` (held or delayed); null when the app never saw it. */
  sent?: number | null;
  /** When the app's answer arrived (headers; a streamed body may take until `end`). */
  response?: number;
  end?: number;
  status?: number;
  failure?: string;
  /** What the harness did to this request. */
  harness?: string[];
}

export interface RaceRecord {
  request: string;
  arrived: { tab: string; arrival: number; step?: string }[];
  /** Release order (tab and arrival number); one entry for `together`. */
  released: string[];
  timedOut: boolean;
}

/** Requests that make up "network activity" for step timing and the request log. */
const TRACKED_TYPES = new Set(["document", "fetch", "xhr"]);

/** Link prefetches are background noise: not logged, and steps don't wait for them. */
function isPrefetch(request: Request): boolean {
  const headers = request.headers();
  return (
    "next-router-prefetch" in headers ||
    headers["sec-purpose"]?.includes("prefetch") === true ||
    headers.purpose === "prefetch"
  );
}

function tracked(request: Request): boolean {
  return TRACKED_TYPES.has(request.resourceType()) && !isPrefetch(request);
}
function pageOf(request: Request): Page | undefined {
  try {
    return request.frame().page();
  } catch {
    return undefined; // service worker requests have no frame
  }
}

const LOST_RESPONSE = "connectionreset";
const DROPPED = "canceled by the browser (page navigated away)";

interface ContextState {
  busy: number;
  parked: number;
}

interface ActivePerturbation {
  spec: NetworkPerturbation;
  pattern: RequestPattern;
  remaining: number;
  matched: number;
}

interface Parked {
  route: Route;
  request: Request;
  tab: NetworkTab;
  record: RequestRecord;
  arrival: number;
  state: ContextState;
  done: () => void;
}

/**
 * Per-run network control for every browser context: logs requests, tracks
 * in-flight work for step timing, applies network perturbations and holds race
 * requests at a barrier.
 */
export class Network {
  readonly log: RequestRecord[] = [];
  race?: RaceRecord;
  /** Set while a step has "refresh during" armed, so every request is routed. */
  refreshArmed = false;
  private readonly t0: number;
  private readonly tabOf: (page: Page) => NetworkTab | undefined;
  private readonly perturbations: ActivePerturbation[];
  private readonly raceSpec?: RaceSpec & { pattern: RequestPattern; count: number; order: RaceOrder };
  private readonly parked: Parked[] = [];
  private raceReleased = false;
  private raceTimer?: NodeJS.Timeout;
  private arrivals = 0;
  private readonly records = new WeakMap<Request, RequestRecord>();
  private readonly states = new Map<BrowserContext, ContextState>();
  /** In-flight requests and the context they count against. */
  private readonly open = new WeakMap<Request, ContextState>();
  private readonly openByPage = new Map<Page, Set<Request>>();
  private readonly work = new Set<Promise<unknown>>();

  constructor(options: {
    t0: number;
    tabOf: (page: Page) => NetworkTab | undefined;
    perturbations: NetworkPerturbation[];
    race?: RaceSpec & { count: number; order: RaceOrder };
  }) {
    this.t0 = options.t0;
    this.tabOf = options.tabOf;
    this.perturbations = options.perturbations.map((spec) => ({
      spec,
      pattern: parseRequestPattern(spec.request),
      remaining: spec.count === "all" ? Number.POSITIVE_INFINITY : spec.count,
      matched: 0,
    }));
    if (options.race) this.raceSpec = { ...options.race, pattern: parseRequestPattern(options.race.request) };
  }

  async attach(context: BrowserContext): Promise<void> {
    const state: ContextState = { busy: 0, parked: 0 };
    this.states.set(context, state);
    context.on("request", (request) => {
      if (!tracked(request)) return;
      const page = pageOf(request);
      // A new document: the browser may never report on requests the old one left open.
      if (page && request.isNavigationRequest() && request.frame() === page.mainFrame()) this.orphan(page);
      state.busy += 1;
      this.open.set(request, state);
      if (page) {
        let set = this.openByPage.get(page);
        if (!set) this.openByPage.set(page, (set = new Set()));
        set.add(request);
      }
      this.recordFor(request);
    });
    context.on("response", (response) => {
      const record = this.records.get(response.request());
      if (record) record.response ??= this.now();
    });
    context.on("requestfinished", (request) => {
      const record = this.settle(request);
      if (record) void request.response().then((r) => (record.status = r?.status()), () => undefined);
    });
    context.on("requestfailed", (request) => {
      const record = this.settle(request, request.failure()?.errorText ?? "failed");
      // The app may have answered before the browser gave up (e.g. a 500, then a navigation).
      if (record) void within(request.response(), 300).then((r) => r && (record.status = r.status()), () => undefined);
    });

    const patterns = [...this.perturbations.map((p) => p.pattern), ...(this.raceSpec ? [this.raceSpec.pattern] : [])];
    await context.route(
      (url) => this.refreshArmed || patterns.some((p) => p.path.test(url.pathname)),
      (route, request) => this.track(this.handle(route, request, state)),
    );
  }

  /** Waits until a context has no unfinished requests (held race requests excepted) for `windowMs`. */
  async quiet(context: BrowserContext, windowMs = 75, maxMs = 15_000): Promise<boolean> {
    const state = this.states.get(context);
    if (!state) return true;
    const deadline = Date.now() + maxMs;
    let since = Date.now();
    while (Date.now() < deadline) {
      if (state.busy - state.parked > 0) since = Date.now();
      else if (Date.now() - since >= windowMs) return true;
      await sleep(10);
    }
    return false;
  }

  /** Releases any held requests and waits for everything the harness sent to the app. */
  async drain(maxMs = 15_000): Promise<void> {
    if (this.parked.length > 0) this.releaseRace(true);
    const deadline = Date.now() + maxMs;
    while (this.work.size > 0 && Date.now() < deadline) {
      await within(Promise.allSettled([...this.work]), deadline - Date.now());
    }
  }

  /**
   * Settles the requests a page left open when it started loading a new document: with the
   * status if the answer had arrived, otherwise as dropped. Held race requests stay held.
   */
  private orphan(page: Page): void {
    for (const request of this.openByPage.get(page) ?? []) {
      if (this.parked.some((p) => p.request === request)) continue;
      void within(request.response(), 300)
        .catch(() => false as const)
        .then((response) => {
          const record = this.settle(request, response ? undefined : DROPPED);
          if (record && response) record.status = response.status();
        });
    }
  }

  /** Marks a request finished, once. Returns its record the first time. */
  private settle(request: Request, failure?: string): RequestRecord | undefined {
    const state = this.open.get(request);
    if (!state) return undefined;
    this.open.delete(request);
    const page = pageOf(request);
    if (page) this.openByPage.get(page)?.delete(request);
    state.busy -= 1;
    const record = this.recordFor(request);
    record.end = this.now();
    if (failure) record.failure = failure;
    return record;
  }

  /**
   * Answers or aborts a routed request. If the browser has already dropped it (the
   * page navigated away), the call succeeds silently and no finished/failed event
   * ever comes, so a request still open after a grace period is settled here.
   */
  private async reply(request: Request, send: () => Promise<void>, graceMs = 2_000): Promise<void> {
    await send().catch(() => undefined);
    if (!this.open.has(request)) return;
    const timer = setTimeout(() => this.settle(request, DROPPED), graceMs);
    timer.unref();
  }

  private async handle(route: Route, request: Request, state: ContextState): Promise<void> {
    const tab = this.tabFor(request);
    if (!tab) return route.fallback();
    const record = this.recordFor(request);
    const method = request.method();
    const url = request.url();

    if (tracked(request) && tab.takeRefresh()) {
      // The server gets the request; the user reloads before the answer arrives.
      note(record, "page refreshed while the app handled this request");
      const answer = route.fetch({ maxRedirects: 0 }).then((r) => r.body());
      void tab.reload();
      await answer.catch(() => undefined);
      await this.reply(request, () => route.abort(LOST_RESPONSE), 0);
      return;
    }

    const race = this.raceSpec;
    if (
      race &&
      !this.raceReleased &&
      matchesRequest(race.pattern, method, url) &&
      (!race.step || tab.stepName === race.step)
    ) {
      return this.park(route, request, tab, record, state);
    }

    const perturbation = this.takePerturbation(method, url, tab);
    if (perturbation) return this.apply(perturbation, route, request, record);
    return route.fallback();
  }

  /** Network perturbations that never matched a request. */
  unused(): NetworkPerturbation[] {
    return this.perturbations.filter((p) => p.matched === 0).map((p) => p.spec);
  }

  private takePerturbation(method: string, url: string, tab: NetworkTab): NetworkPerturbation | undefined {
    for (const p of this.perturbations) {
      if (p.remaining <= 0) continue;
      if (p.spec.step && p.spec.step !== tab.stepName) continue;
      if (p.spec.tab && p.spec.tab !== tab.label) continue;
      if (!matchesRequest(p.pattern, method, url)) continue;
      p.remaining -= 1;
      p.matched += 1;
      return p.spec;
    }
    return undefined;
  }

  /** Applies a perturbation; resolves once the app has answered (or was never asked). */
  private async apply(p: NetworkPerturbation, route: Route, request: Request, record: RequestRecord): Promise<void> {
    switch (p.do) {
      case "delay":
        note(record, `delayed ${p.ms} ms`);
        await sleep(p.ms);
        record.sent = Date.now() - this.t0;
        return this.forward(route, request);
      case "fail":
        note(record, `answered ${p.status} by the harness; the app never saw it`);
        record.sent = null;
        return this.reply(request, () =>
          route.fulfill({ status: p.status, contentType: "text/plain", body: "Service unavailable (injected)" }),
        );
      case "lose-response": {
        const response = await route.fetch({ maxRedirects: 0 });
        await response.body().catch(() => undefined);
        record.response ??= this.now();
        note(record, `response lost: the app answered ${response.status()}, the browser saw a network error`);
        return this.reply(request, () => route.abort(LOST_RESPONSE));
      }
      case "duplicate": {
        const [first, second] = await Promise.all([route.fetch({ maxRedirects: 0 }), route.fetch({ maxRedirects: 0 })]);
        record.response ??= this.now();
        note(record, `sent to the app twice (${first.status()}, ${second.status()}); the browser got the first answer`);
        return this.reply(request, () => route.fulfill({ response: first }));
      }
    }
  }

  private async forward(route: Route, request: Request): Promise<void> {
    const response = await route.fetch({ maxRedirects: 0 });
    await this.reply(request, () => route.fulfill({ response }));
  }

  private park(route: Route, request: Request, tab: NetworkTab, record: RequestRecord, state: ContextState): Promise<void> {
    const race = this.raceSpec!;
    const arrival = ++this.arrivals;
    note(record, `held at the race barrier (arrival ${arrival})`);
    state.parked += 1;
    return new Promise<void>((done) => {
      this.parked.push({ route, request, tab, record, arrival, state, done });
      if (this.parked.length === 1) this.raceTimer = setTimeout(() => this.releaseRace(true), race.timeout);
      if (this.parked.length >= race.count) this.releaseRace(false);
    });
  }

  private releaseRace(timedOut: boolean): void {
    if (this.raceReleased) return;
    this.raceReleased = true;
    clearTimeout(this.raceTimer);
    const race = this.raceSpec!;
    const entries = this.parked.splice(0);
    const ordered = orderEntries(race.order, entries);
    this.race = {
      request: race.request,
      arrived: entries.map((e) => ({ tab: e.tab.label, arrival: e.arrival, step: e.record.step })),
      released: race.order === "together" ? ["together"] : ordered.map((e) => `${e.tab.label} (arrival ${e.arrival})`),
      timedOut,
    };
    const go = async (entry: Parked, position: number) => {
      entry.state.parked -= 1;
      note(entry.record, race.order === "together" ? "released with the others" : `released ${ordinal(position)}`);
      entry.record.sent = Date.now() - this.t0;
      try {
        const perturbation = this.takePerturbation(entry.request.method(), entry.request.url(), entry.tab);
        await (perturbation
          ? this.apply(perturbation, entry.route, entry.request, entry.record)
          : this.forward(entry.route, entry.request));
      } catch (err) {
        note(entry.record, `release failed: ${(err as Error).message.split("\n")[0]}`);
        await this.reply(entry.request, () => entry.route.abort());
      } finally {
        entry.done();
      }
    };
    this.track(
      (async () => {
        if (race.order === "together") await Promise.all(ordered.map((e, i) => go(e, i + 1)));
        else for (const [i, e] of ordered.entries()) await go(e, i + 1);
      })(),
    );
  }

  private recordFor(request: Request): RequestRecord {
    let record = this.records.get(request);
    if (!record) {
      const url = new URL(request.url());
      const tab = this.tabFor(request);
      record = {
        id: this.log.length + 1,
        tab: tab?.label ?? "?",
        step: tab?.stepName,
        method: request.method(),
        url: url.pathname + url.search,
        type: request.resourceType(),
        start: this.now(),
      };
      this.records.set(request, record);
      this.log.push(record);
    }
    return record;
  }

  private tabFor(request: Request): NetworkTab | undefined {
    try {
      return this.tabOf(request.frame().page());
    } catch {
      return undefined;
    }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.catch(() => undefined);
    this.work.add(tracked);
    void tracked.finally(() => this.work.delete(tracked));
    return promise;
  }

  private now(): number {
    return Date.now() - this.t0;
  }
}

function orderEntries(order: RaceOrder, entries: Parked[]): Parked[] {
  const byArrival = [...entries].sort((a, b) => a.arrival - b.arrival);
  if (order === "together" || order === "arrival") return byArrival;
  if (order === "reverse") return byArrival.reverse();
  const result: Parked[] = [];
  for (const item of order) {
    const entry = byArrival.find(
      (e) => !result.includes(e) && (typeof item === "number" ? e.arrival === item : e.tab.label === item),
    );
    if (entry) result.push(entry);
  }
  return [...result, ...byArrival.filter((e) => !result.includes(e))];
}

function note(record: RequestRecord, text: string): void {
  (record.harness ??= []).push(text);
}

function ordinal(n: number): string {
  return n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `#${n}`;
}


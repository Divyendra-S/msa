import type { NetworkPerturbation, RaceOrder, RaceSpec } from "./experiment.ts";
import { matchesRequest, parseRequestPattern, type RequestPattern } from "./match.ts";
import { sleep, within } from "./time.ts";

/** Clients whose calls count together when a step waits for quiet: a browser context, a phone. */
export interface Group {
  busy: number;
  parked: number;
}

export function newGroup(): Group {
  return { busy: 0, parked: 0 };
}

/** What a tab exposes to the network layer. */
export interface NetworkTab {
  label: string;
  /** Where its calls count as in flight. */
  readonly group: Group;
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
  /** The user whose session sent it, when that isn't the tab's own (a `replay-as`). */
  user?: string;
}

export interface RaceRecord {
  request: string;
  arrived: { tab: string; arrival: number; step?: string }[];
  /** Release order (tab and arrival number); one entry for `together`. */
  released: string[];
  timedOut: boolean;
}

/** The app's answer to a call, as its transport keeps it; only the status is shared. */
export interface Answer {
  readonly status: number;
}

/**
 * One call caught at the seam, carried by its transport: a browser route, a proxied HTTP
 * request, an `invoke` in a Tauri page. The network layer decides what happens to it; the
 * transport knows how.
 */
export interface Call {
  readonly method: string;
  /** Absolute URL. */
  readonly url: string;
  /** As the client sent them, lower-case names. */
  readonly headers: Record<string, string>;
  readonly body?: Buffer;
  /** A page load or an API call, as opposed to a script, stylesheet or image. */
  readonly tracked: boolean;
  /** Sends the call to the app and resolves with its whole answer; the client hasn't seen it yet. */
  send(): Promise<Answer>;
  /** Gives the client an answer from `send()`. */
  answer(answer: Answer): Promise<void>;
  /** Gives the client an answer the harness made up. */
  fulfill(status: number, body: string): Promise<void>;
  /** The client sees a network error instead of an answer. `abandoned`: it has stopped waiting (the page reloaded). */
  drop(options?: { abandoned?: boolean }): Promise<void>;
  /** Lets the call through untouched. */
  pass(): Promise<void>;
}

/** Sends a call again with `user`'s session after the app answered `original`. */
export type Replayer = (user: string, call: Call, original: RequestRecord) => Promise<RequestRecord>;

interface ActivePerturbation {
  spec: NetworkPerturbation;
  pattern: RequestPattern;
  remaining: number;
  matched: number;
}

interface Parked {
  call: Call;
  tab: NetworkTab;
  record: RequestRecord;
  arrival: number;
  group?: Group;
  done: () => void;
}

/**
 * Per-run network control, whatever carries the calls: logs requests, tracks in-flight work
 * for step timing, applies network perturbations and holds race requests at a barrier.
 * Transports log calls (`record`, `opened`, `settle`) and hand the ones they catch to `handle`.
 */
export class Network {
  readonly log: RequestRecord[] = [];
  race?: RaceRecord;
  /** Set while a step has "refresh during" armed, so every request is routed. */
  refreshArmed = false;
  private readonly t0: number;
  /** Who gets answers, in harness notes: `browser`, `app`. */
  private readonly client: string;
  private readonly perturbations: ActivePerturbation[];
  private readonly raceSpec?: RaceSpec & { pattern: RequestPattern; count: number; order: RaceOrder };
  private readonly parked: Parked[] = [];
  private raceReleased = false;
  private raceTimer?: NodeJS.Timeout;
  private arrivals = 0;
  /** In-flight requests and the group they count against. */
  private readonly open = new Map<RequestRecord, Group>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly replay?: Replayer;

  constructor(options: {
    t0: number;
    perturbations: NetworkPerturbation[];
    race?: RaceSpec & { count: number; order: RaceOrder };
    /** Sends a request again as another user (`replay-as`). */
    replay?: Replayer;
    client?: string;
  }) {
    this.t0 = options.t0;
    this.client = options.client ?? "browser";
    this.replay = options.replay;
    this.perturbations = options.perturbations.map((spec) => ({
      spec,
      pattern: parseRequestPattern(spec.request),
      remaining: spec.count === "all" ? Number.POSITIVE_INFINITY : spec.count,
      matched: 0,
    }));
    if (options.race) this.raceSpec = { ...options.race, pattern: parseRequestPattern(options.race.request) };
  }

  /** Whether calls to this URL may need the harness (a transport can let the rest through unseen). */
  wants(url: URL): boolean {
    return (
      this.refreshArmed ||
      this.perturbations.some((p) => p.pattern.path.test(url.pathname)) ||
      (!!this.raceSpec && this.raceSpec.pattern.path.test(url.pathname))
    );
  }

  /** Logs a call; `start` defaults to now. */
  record(fields: Omit<RequestRecord, "id" | "start"> & { start?: number }): RequestRecord {
    const record: RequestRecord = { id: this.log.length + 1, ...fields, start: fields.start ?? this.now() };
    this.log.push(record);
    return record;
  }

  /** The call is in flight: steps in its group wait for it. */
  opened(record: RequestRecord, group: Group): void {
    if (this.open.has(record)) return;
    group.busy += 1;
    this.open.set(record, group);
  }

  /** Marks a call finished, once; false when it already was (or was never opened). */
  settle(record: RequestRecord, failure?: string): boolean {
    const group = this.open.get(record);
    if (!group) return false;
    this.open.delete(record);
    group.busy -= 1;
    record.end = this.now();
    if (failure) record.failure = failure;
    return true;
  }

  isOpen(record: RequestRecord): boolean {
    return this.open.has(record);
  }

  /** Held at the race barrier right now. */
  isHeld(record: RequestRecord): boolean {
    return this.parked.some((p) => p.record === record);
  }

  /** Waits until a group has no unfinished requests (held race requests excepted) for `windowMs`. */
  async quiet(group: Group | undefined, windowMs = 75, maxMs = 15_000): Promise<boolean> {
    if (!group) return true;
    const deadline = Date.now() + maxMs;
    let since = Date.now();
    while (Date.now() < deadline) {
      if (group.busy - group.parked > 0) since = Date.now();
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

  /** Decides what happens to a call from `tab`: a refresh, the race barrier, a perturbation, or nothing. */
  handle(call: Call, tab: NetworkTab, record: RequestRecord): Promise<void> {
    return this.track(this.decide(call, tab, record));
  }

  private async decide(call: Call, tab: NetworkTab, record: RequestRecord): Promise<void> {
    if (call.tracked && tab.takeRefresh()) {
      // The server gets the request; the user reloads before the answer arrives.
      note(record, "page refreshed while the app handled this request");
      const answer = call.send();
      void tab.reload();
      await answer.catch(() => undefined);
      await call.drop({ abandoned: true });
      return;
    }

    const race = this.raceSpec;
    if (
      race &&
      !this.raceReleased &&
      matchesRequest(race.pattern, call.method, call.url) &&
      (!race.step || tab.stepName === race.step)
    ) {
      return this.park(call, tab, record);
    }

    const perturbation = this.takePerturbation(call.method, call.url, tab);
    if (perturbation) return this.apply(perturbation, call, record);
    return call.pass();
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
  private async apply(p: NetworkPerturbation, call: Call, record: RequestRecord): Promise<void> {
    switch (p.do) {
      case "delay":
        note(record, `delayed ${p.ms} ms`);
        await sleep(p.ms);
        record.sent = this.now();
        return this.forward(call);
      case "fail":
        note(record, `answered ${p.status}${p.after ? ` after ${p.after} ms` : ""} by the harness; the app never saw it`);
        record.sent = null;
        if (p.after) await sleep(p.after);
        return call.fulfill(p.status, "Service unavailable (injected)");
      case "lose-response": {
        const answer = await call.send();
        record.response ??= this.now();
        note(record, `response lost: the app answered ${answer.status}, the ${this.client} saw a network error`);
        return call.drop();
      }
      case "duplicate": {
        const [first, second] = await Promise.all([call.send(), call.send()]);
        record.response ??= this.now();
        note(record, `sent to the app twice (${first.status}, ${second.status}); the ${this.client} got the first answer`);
        return call.answer(first);
      }
      case "replay-as": {
        const answer = await call.send();
        record.response ??= this.now();
        await call.answer(answer);
        const replayed = await this.replay?.(p.user, call, record).catch((err: Error) => err);
        if (!replayed || replayed instanceof Error) {
          note(record, `could not replay it as ${p.user}${replayed ? `: ${replayed.message.split("\n")[0]}` : ""}`);
        } else {
          note(record, `replayed as ${p.user} (request ${replayed.id}): ${replayed.status ?? replayed.failure}`);
        }
        return;
      }
    }
  }

  /** Logs a request the harness sent itself, not a client (a replay); returns its record. */
  external(fields: Omit<RequestRecord, "id">): RequestRecord {
    return this.record(fields);
  }

  private async forward(call: Call): Promise<void> {
    await call.answer(await call.send());
  }

  private park(call: Call, tab: NetworkTab, record: RequestRecord): Promise<void> {
    const race = this.raceSpec!;
    const arrival = ++this.arrivals;
    note(record, `held at the race barrier (arrival ${arrival})`);
    const group = this.open.get(record);
    if (group) group.parked += 1;
    return new Promise<void>((done) => {
      this.parked.push({ call, tab, record, arrival, group, done });
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
      if (entry.group) entry.group.parked -= 1;
      note(entry.record, race.order === "together" ? "released with the others" : `released ${ordinal(position)}`);
      entry.record.sent = this.now();
      try {
        const perturbation = this.takePerturbation(entry.call.method, entry.call.url, entry.tab);
        await (perturbation ? this.apply(perturbation, entry.call, entry.record) : this.forward(entry.call));
      } catch (err) {
        note(entry.record, `release failed: ${(err as Error).message.split("\n")[0]}`);
        await entry.call.drop().catch(() => undefined);
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

  private track<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.catch(() => undefined);
    this.work.add(tracked);
    void tracked.finally(() => this.work.delete(tracked));
    return promise;
  }

  now(): number {
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

/** Link prefetches are background noise: not logged, and steps don't wait for them. */
export function isPrefetch(headers: Record<string, string | undefined>): boolean {
  return "next-router-prefetch" in headers || headers["sec-purpose"]?.includes("prefetch") === true || headers.purpose === "prefetch";
}

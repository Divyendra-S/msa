import type { APIResponse, BrowserContext, Page, Request, Route } from "playwright";
import {
  type Answer,
  type Call,
  callName,
  type Group,
  isHarnessCall,
  isPrefetch,
  type Network,
  type NetworkTab,
  type RequestRecord,
} from "./network.ts";
import { within } from "./time.ts";

/** Requests that make up "network activity" for step timing and the request log. */
const TRACKED_TYPES = new Set(["document", "fetch", "xhr"]);

const LOST_RESPONSE = "connectionreset";
const DROPPED = "canceled by the browser (page navigated away)";

function tracked(request: Request): boolean {
  return TRACKED_TYPES.has(request.resourceType()) && !isPrefetch(request.headers()) && !isHarnessCall(new URL(request.url()));
}

function pageOf(request: Request): Page | undefined {
  try {
    return request.frame().page();
  } catch {
    return undefined; // service worker requests have no frame
  }
}

interface RouteAnswer extends Answer {
  response: APIResponse;
}

/**
 * The seam for a browser: Playwright's routes on one context. Every page load and API call is
 * logged from the context's events; the calls the network layer may need are routed to it.
 */
export async function routeBrowser(
  network: Network,
  context: BrowserContext,
  group: Group,
  tabOf: (page: Page) => NetworkTab | undefined,
): Promise<void> {
  const records = new WeakMap<Request, RequestRecord>();
  const openByPage = new Map<Page, Set<Request>>();

  const tabFor = (request: Request) => {
    const page = pageOf(request);
    return page && tabOf(page);
  };
  const recordFor = (request: Request): RequestRecord => {
    let record = records.get(request);
    if (!record) {
      const tab = tabFor(request);
      record = network.record({
        tab: tab?.label ?? "?",
        step: tab?.stepName,
        ...callName(request.method(), new URL(request.url())),
        type: request.resourceType(),
      });
      records.set(request, record);
    }
    return record;
  };
  /** Marks a request finished, once. Returns its record the first time. */
  const settle = (request: Request, failure?: string): RequestRecord | undefined => {
    const record = records.get(request);
    if (!record || !network.settle(record, failure)) return undefined;
    const page = pageOf(request);
    if (page) openByPage.get(page)?.delete(request);
    return record;
  };
  /**
   * Settles the requests a page left open when it started loading a new document: with the
   * status if the answer had arrived, otherwise as dropped. Held race requests stay held.
   */
  const orphan = (page: Page) => {
    for (const request of openByPage.get(page) ?? []) {
      const record = records.get(request);
      if (record && network.isHeld(record)) continue;
      void within(request.response(), 300)
        .catch(() => false as const)
        .then((response) => {
          const settled = settle(request, response ? undefined : DROPPED);
          if (settled && response) settled.status = response.status();
        });
    }
  };
  /**
   * Answers or aborts a routed request. If the browser has already dropped it (the page
   * navigated away), the call succeeds silently and no finished/failed event ever comes, so a
   * request still open after a grace period is settled here.
   */
  const reply = async (request: Request, send: () => Promise<void>, graceMs = 2_000) => {
    await send().catch(() => undefined);
    const record = records.get(request);
    if (!record || !network.isOpen(record)) return;
    const timer = setTimeout(() => settle(request, DROPPED), graceMs);
    timer.unref();
  };

  context.on("request", (request) => {
    if (!tracked(request)) return;
    const page = pageOf(request);
    // A new document: the browser may never report on requests the old one left open.
    if (page && request.isNavigationRequest() && request.frame() === page.mainFrame()) orphan(page);
    network.opened(recordFor(request), group);
    if (page) {
      let set = openByPage.get(page);
      if (!set) openByPage.set(page, (set = new Set()));
      set.add(request);
    }
  });
  context.on("response", (response) => {
    const record = records.get(response.request());
    if (record) record.response ??= network.now();
  });
  context.on("requestfinished", (request) => {
    const record = settle(request);
    if (record) void request.response().then((r) => (record.status = r?.status()), () => undefined);
  });
  context.on("requestfailed", (request) => {
    const record = settle(request, request.failure()?.errorText ?? "failed");
    // The app may have answered before the browser gave up (e.g. a 500, then a navigation).
    if (record) void within(request.response(), 300).then((r) => r && (record.status = r.status()), () => undefined);
  });

  await context.route(
    (url) => network.wants(url),
    (route, request) => {
      const tab = tabFor(request);
      if (!tab) return route.fallback();
      const call: Call = {
        method: request.method(),
        url: request.url(),
        headers: request.headers(),
        body: request.postDataBuffer() ?? undefined,
        tracked: tracked(request),
        send: async (): Promise<RouteAnswer> => {
          const response = await route.fetch({ maxRedirects: 0 });
          await response.body().catch(() => undefined);
          return { status: response.status(), response };
        },
        answer: (answer) => reply(request, () => route.fulfill({ response: (answer as RouteAnswer).response })),
        fulfill: (status, body) => reply(request, () => route.fulfill({ status, contentType: "text/plain", body })),
        drop: (options) => reply(request, () => route.abort(LOST_RESPONSE), options?.abandoned ? 0 : undefined),
        pass: () => route.fallback(),
      };
      return network.handle(call, tab, recordFor(request));
    },
  );
}

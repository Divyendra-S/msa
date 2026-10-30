import type { Browser, BrowserContext, Page } from "playwright";
import type { Driver, DriverSession, DriverTab, ScreenState, Seen, SessionOptions, TabHooks } from "./driver.ts";
import { instrumentPage } from "./instrument.ts";
import { TAB_HEADER } from "./proxy.ts";
import { routeBrowser } from "./route.ts";
import { snapshotPage } from "./snapshot.ts";
import { within } from "./time.ts";

/** Page text kept per step. */
const MAX_SEEN = 2_000;

/** Web apps: each session is a browser context, each tab a page. */
export class PlaywrightDriver implements Driver {
  private readonly browser: Browser;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async session(user: string, options: SessionOptions): Promise<DriverSession> {
    const context = await this.browser.newContext({
      baseURL: options.baseUrl,
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "UTC",
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    context.setDefaultTimeout(10_000);
    context.setDefaultNavigationTimeout(15_000);
    if (options.clock) await context.clock.install({ time: options.clock });
    const labels = new Map<Page, string>();
    if (options.route) {
      const { network, group, tabOf } = options.route;
      await routeBrowser(network, context, group, (page) => {
        const label = labels.get(page);
        return label === undefined ? undefined : tabOf(label);
      });
    }
    if (options.trace) await context.tracing.start({ snapshots: true, screenshots: true, title: options.trace });
    return new PlaywrightSession(user, context, labels, options);
  }
}

class PlaywrightSession implements DriverSession {
  readonly user: string;
  private readonly context: BrowserContext;
  private readonly labels: Map<Page, string>;
  private readonly options: SessionOptions;

  constructor(user: string, context: BrowserContext, labels: Map<Page, string>, options: SessionOptions) {
    this.user = user;
    this.context = context;
    this.labels = labels;
    this.options = options;
  }

  async open(label: string, hooks: TabHooks): Promise<DriverTab> {
    const page = await this.context.newPage();
    this.labels.set(page, label);
    if (this.options.tagTabs) await page.setExtraHTTPHeaders({ [TAB_HEADER]: label });
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") hooks.onConsole(msg.type(), msg.text());
    });
    page.on("pageerror", (err) => hooks.onConsole("pageerror", err.message));
    return new PlaywrightTab(page, instrumentPage(page, hooks.onAction));
  }

  async expire(cookie?: string): Promise<void> {
    await this.context.clearCookies(cookie ? { name: cookie } : undefined);
  }

  async advanceClock(ms: number): Promise<void> {
    await this.context.clock.fastForward(ms);
  }

  async fetch(url: string, init: { method: string; headers: Record<string, string>; body?: Buffer }): Promise<{ status: number }> {
    const response = await this.context.request.fetch(url, {
      method: init.method,
      headers: init.headers,
      data: init.body,
      maxRedirects: 0,
      failOnStatusCode: false,
      timeout: 15_000,
    });
    await response.body().catch(() => undefined);
    return { status: response.status() };
  }

  async close(tracePath?: string): Promise<boolean> {
    let saved = false;
    if (this.options.trace) {
      await this.context.tracing.stop(tracePath ? { path: tracePath } : undefined).then(
        () => (saved = !!tracePath),
        () => undefined,
      );
    }
    await this.context.close().catch(() => undefined);
    return saved;
  }
}

class PlaywrightTab implements DriverTab {
  readonly surface: DriverTab["surface"];
  private readonly page: Page;

  constructor(page: Page, view: Page) {
    this.page = page;
    this.surface = { page: view, clock: page.clock };
  }

  url(): string {
    return this.page.url();
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url).catch(() => undefined);
  }

  async reload(): Promise<void> {
    await this.page.reload().catch(() => undefined);
  }

  async back(): Promise<void> {
    await this.page.goBack().catch(() => undefined);
  }

  /** The page's path and visible text, whitespace collapsed. */
  async seen(): Promise<Seen | undefined> {
    const page = this.page;
    if (page.isClosed()) return undefined;
    const text = await within(page.locator("body").innerText({ timeout: 1_000 }).catch(() => undefined), 1_500);
    if (typeof text !== "string") return undefined;
    return { path: pathOf(page.url()), text: text.replace(/\s+/g, " ").trim().slice(0, MAX_SEEN) };
  }

  async state(): Promise<ScreenState | undefined> {
    const page = this.page;
    try {
      const path = new URL(page.url()).pathname;
      const alerts = (await within(page.getByRole("alert").allInnerTexts(), 1_000)) || [];
      const body = (await within(page.locator("body").innerText({ timeout: 1_000 }), 1_500)) || "";
      return { path, alerts: alerts.map((a) => a.trim()).filter(Boolean), text: body.replace(/\s+/g, " ").trim().slice(0, 300) };
    } catch {
      return undefined;
    }
  }

  snapshot() {
    return snapshotPage(this.page);
  }

  screenshot(path: string, options: { quality: number; timeoutMs: number }): Promise<boolean> {
    return this.page.screenshot({ path, type: "jpeg", quality: options.quality, timeout: options.timeoutMs }).then(
      () => true,
      () => false,
    );
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

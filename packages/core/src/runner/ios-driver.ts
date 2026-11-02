import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandVars } from "../config.ts";
import { parseIosScreen } from "../ios/screen.ts";
import { appDataContainer, simctl } from "../ios/simctl.ts";
import type { WebDriverAgent } from "../ios/wda.ts";
import { findControl, type Screen, type ScreenNode, screenAlerts, screenTexts, snapshotScreen } from "../phone/screen.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { exists } from "../project.ts";
import type { Driver, DriverSession, DriverTab, ScreenState, Seen, SessionOptions, TabHooks } from "./driver.ts";
import type { ActionHook } from "./instrument.ts";
import { jpegFromPng, type PhoneScreen, type PhoneTab, Ui } from "./phone-ui.ts";
import type { HttpProxy } from "./proxy.ts";
import type { PageSnapshot } from "./snapshot.ts";
import { sleep } from "./time.ts";

const POLL_MS = 100;
/** Screen text kept per step, like a page's. */
const MAX_SEEN = 2_000;
/** iOS asks before a link from outside opens an app: "Open in “Shop”?". */
const OPEN_PROMPT = /^Open in /;

/** The app under test on the simulator. */
export interface IosApp {
  bundleId: string;
  /** The simulator build (`.app`). */
  app: string;
  /** Launch arguments and environment; `$BASE_URL` is where this phone reaches its server. */
  arguments: string[];
  env: Record<string, string>;
}

/** Apps on iOS simulators: each user gets a simulator from the run's lease, each simulator runs the app once. */
export class IosDriver implements Driver {
  private readonly phones: string[];
  private readonly app: IosApp;
  private readonly proxy: HttpProxy;
  /** WebDriverAgent on a simulator, started on first use and kept for the runner's life. */
  private readonly agent: (udid: string) => Promise<WebDriverAgent>;

  constructor(options: { phones: string[]; app: IosApp; proxy: HttpProxy; agent: (udid: string) => Promise<WebDriverAgent> }) {
    this.phones = [...options.phones];
    this.app = options.app;
    this.proxy = options.proxy;
    this.agent = options.agent;
  }

  async session(user: string, _options: SessionOptions): Promise<DriverSession> {
    const udid = this.phones.shift();
    if (!udid) throw new Error(`no phone left for ${user}: each user needs one, and a phone runs the app once`);
    return new IosSession(udid, await this.agent(udid), this.app, this.proxy);
  }
}

class IosSession implements DriverSession {
  private readonly udid: string;
  private readonly wda: WebDriverAgent;
  private readonly app: IosApp;
  private readonly proxy: HttpProxy;
  private tab?: IosTab;
  private port?: number;
  private label?: string;

  constructor(udid: string, wda: WebDriverAgent, app: IosApp, proxy: HttpProxy) {
    this.udid = udid;
    this.wda = wda;
    this.app = app;
    this.proxy = proxy;
  }

  async open(label: string, hooks: TabHooks): Promise<DriverTab> {
    if (this.tab) throw new Error("a phone shows one app: second tabs are for web apps");
    // The simulator shares this Mac's network, so its 127.0.0.1:<port> is this tab's proxy port.
    this.port = await allocatePort();
    this.label = label;
    const url = await this.proxy.listenFor(label, this.port);
    const tab = new IosTab(this.udid, this.wda, this.app, url, hooks.onAction);
    await tab.reset();
    await tab.launch();
    this.tab = tab;
    return tab;
  }

  expire(): Promise<void> {
    return Promise.reject(new Error("expire-session is for web apps: a phone app keeps its own login (use a sql perturbation on the server's sessions)"));
  }

  advanceClock(): Promise<void> {
    return Promise.reject(new Error("advance-clock is for web apps"));
  }

  fetch(): Promise<{ status: number }> {
    return Promise.reject(new Error("replay-as is for web apps"));
  }

  async close(): Promise<boolean> {
    await this.tab?.close();
    if (this.label) await this.proxy.stopListening(this.label).catch(() => undefined);
    if (this.port) releasePort(this.port);
    return false;
  }
}

class IosTab implements PhoneTab, PhoneScreen {
  readonly surface: { ui: Ui };
  private readonly udid: string;
  private readonly wda: WebDriverAgent;
  private readonly app: IosApp;
  /** Where this phone reaches its server. */
  private readonly baseUrl: string;

  constructor(udid: string, wda: WebDriverAgent, app: IosApp, baseUrl: string, hook: ActionHook) {
    this.udid = udid;
    this.wda = wda;
    this.app = app;
    this.baseUrl = baseUrl;
    this.surface = { ui: new Ui(this, hook) };
  }

  /** The phone as every run finds it: the app installed afresh (none of its data left), portrait. */
  async reset(): Promise<void> {
    await this.kill();
    await simctl(["uninstall", this.udid, this.app.bundleId], { timeoutMs: 60_000 });
    await simctl(["install", this.udid, this.app.app], { timeoutMs: 120_000 });
    await this.rotate(false);
  }

  async launch(): Promise<void> {
    const vars = { BASE_URL: this.baseUrl };
    const args = this.app.arguments.map((a) => expandVars(a, vars));
    const env = Object.fromEntries(Object.entries(this.app.env).map(([k, v]) => [k, expandVars(v, vars)]));
    await simctl(["launch", this.udid, this.app.bundleId, ...args], { env, timeoutMs: 60_000 });
    // A link's question left over from an earlier run would take every tap meant for the app.
    await this.answerOpenPrompt("Cancel", 0);
    // `simctl launch` returns once the process runs, maybe before it shows anything.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const screen = await this.screen().catch(() => undefined);
      if (screen && screenTexts(screen).length > 0) return;
      await sleep(POLL_MS);
    }
  }

  async kill(): Promise<void> {
    await simctl(["terminate", this.udid, this.app.bundleId]).catch(() => undefined);
  }

  async reopen(): Promise<void> {
    await this.launch();
  }

  async background(): Promise<void> {
    await this.wda.pressButton("home");
  }

  async rotate(landscape: boolean): Promise<void> {
    await this.wda.orientation(landscape ? "LANDSCAPE" : "PORTRAIT");
  }

  /** A simulator has no airplane mode: the proxy drops the phone's calls while it's offline. */
  async online(_on: boolean): Promise<void> {}

  /** `simctl push`: the notification iOS hands the app, as if from Apple's push service. */
  async push(payload: Record<string, unknown>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "wt-push-"));
    try {
      const file = join(dir, "push.json");
      await writeFile(file, JSON.stringify(payload));
      await simctl(["push", this.udid, this.app.bundleId, file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The app's data folder is on this Mac (`simctl get_app_container`): its files are copied from there. */
  async appFile(path: string, dest: string): Promise<boolean> {
    const container = await appDataContainer(this.udid, this.app.bundleId).catch(() => undefined);
    if (!container || !(await exists(join(container, path)))) return false;
    await mkdir(dirname(dest), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      if (await exists(join(container, path + suffix))) await copyFile(join(container, path + suffix), dest + suffix);
    }
    return true;
  }

  /** The screen as XCUITest sees it. */
  async screen(): Promise<Screen> {
    return parseIosScreen(await this.wda.source());
  }

  async tapAt(x: number, y: number, twice = false): Promise<void> {
    const tap = [
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 1 },
      { type: "pointerUp", button: 0 },
    ];
    await this.wda.actions([
      {
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "touch" },
        actions: [{ type: "pointerMove", duration: 0, x, y }, ...tap, ...(twice ? [{ type: "pause", duration: 1 }, ...tap] : [])],
      },
    ]);
  }

  /**
   * Finds the field again by what it's labelled (XCUITest has no stable index), types into it,
   * and checks the text arrived: a system alert over the app takes the keys without a word.
   */
  async type(field: { node: ScreenNode; index: number }, value: string): Promise<void> {
    const { node } = field;
    const by = node.identifier
      ? `name == ${predicateString(node.identifier)}`
      : node.hint
        ? `placeholderValue == ${predicateString(node.hint)}`
        : `label == ${predicateString(node.desc)}`;
    const element = await this.wda.find(`type == ${predicateString(node.className)} AND ${by}`);
    if (!element) throw new Error(`the field "${node.desc || node.hint || node.identifier}" went away`);
    await this.wda.type(element, value);
    if (node.password) return;
    const typed = parseIosScreen(await this.wda.source()).nodes.find(
      (n) => n.className === node.className && n.identifier === node.identifier && n.hint === node.hint && n.desc === node.desc,
    );
    if (typed && !typed.text.includes(value)) {
      const alert = await this.wda.alertText();
      throw new Error(`typing "${value}" didn't reach the field${alert ? `: an alert is up ("${alert}")` : ""}`);
    }
  }

  pressBack(): Promise<void> {
    return Promise.reject(new Error("an iOS phone has no Back button: tap the app's own (`ui.tap(\"Back\")`)"));
  }

  /** Each time, iOS may ask whether to open the app, as for a link tapped in Safari: the user says Open. */
  async openLink(url: string, twice = false): Promise<void> {
    for (let i = 0; i < (twice ? 2 : 1); i++) {
      await simctl(["openurl", this.udid, url]);
      await this.answerOpenPrompt("Open", 1_500);
    }
  }

  /**
   * Answers iOS's "Open in “App”?" if it shows within `waitMs`. XCUITest's own alert buttons
   * don't answer this one, so its button is tapped where SpringBoard draws it.
   */
  private async answerOpenPrompt(button: "Open" | "Cancel", waitMs: number): Promise<void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (OPEN_PROMPT.test((await this.wda.alertText()) ?? "")) break;
      if (Date.now() >= deadline) return;
      await sleep(POLL_MS);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = findControl(parseIosScreen(await this.wda.springboardSource()), button);
      if (!found.ok) return;
      await this.tapAt(found.value.x, found.value.y);
      await sleep(300);
      if (!OPEN_PROMPT.test((await this.wda.alertText()) ?? "")) return;
    }
    throw new Error(`iOS's "Open in…" question stayed up after tapping ${button}`);
  }

  url(): string {
    return `${this.app.bundleId}:`;
  }

  open(): Promise<void> {
    return Promise.reject(new Error("a phone app has no address to open"));
  }

  async reload(): Promise<void> {
    await this.kill();
    await this.reopen();
  }

  async back(): Promise<void> {
    await this.pressBack();
  }

  async seen(): Promise<Seen | undefined> {
    const screen = await this.screen().catch(() => undefined);
    if (!screen) return undefined;
    return { path: "", text: screenTexts(screen).join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_SEEN) };
  }

  async state(): Promise<ScreenState | undefined> {
    const screen = await this.screen().catch(() => undefined);
    if (!screen) return undefined;
    return { path: "", alerts: screenAlerts(screen), text: screenTexts(screen).join(" ").slice(0, 300) };
  }

  async snapshot(): Promise<PageSnapshot | undefined> {
    const screen = await this.screen().catch(() => undefined);
    return screen && snapshotScreen(screen, "", this.app.bundleId);
  }

  /** `simctl io screenshot`, made a JPEG like a browser's screenshot. */
  async screenshot(path: string, options: { quality: number; timeoutMs: number }): Promise<boolean> {
    const dir = await mkdtemp(join(tmpdir(), "wt-shot-"));
    try {
      const file = join(dir, "screen.png");
      await simctl(["io", this.udid, "screenshot", "--type=png", file], { timeoutMs: options.timeoutMs });
      return await jpegFromPng(await readFile(file), path, options);
    } catch {
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await this.answerOpenPrompt("Cancel", 0).catch(() => undefined);
    await this.kill();
    await this.rotate(false).catch(() => undefined);
  }
}

/** A string in an NSPredicate. */
function predicateString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

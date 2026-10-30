import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Appium, PhoneSession } from "../android/appium.ts";
import { DRAWING_ON } from "../android/emulators.ts";
import { adb, adbRaw, type AndroidSdk, shell } from "../android/sdk.ts";
import { findControl, findField, matchesText, parseScreen, type Screen, screenAlerts, screenTexts, snapshotScreen } from "../android/screen.ts";
import { expandVars } from "../config.ts";
import { sh } from "../exec.ts";
import type { PhoneUi } from "../flow-api.ts";
import { allocatePort, releasePort } from "../ports.ts";
import type { Driver, DriverSession, DriverTab, ScreenState, Seen, SessionOptions, TabHooks } from "./driver.ts";
import type { ActionHook } from "./instrument.ts";
import type { HttpProxy } from "./proxy.ts";
import type { PageSnapshot } from "./snapshot.ts";
import { sleep } from "./time.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;
/** Screen text kept per step, like a page's. */
const MAX_SEEN = 2_000;

/** The app under test on the phone. */
export interface AndroidApp {
  package: string;
  /** Launched with `am start -n <package>/<activity>`. */
  activity: string;
  apk: string;
  /** `am start --es` extras; `$BASE_URL` is where this phone reaches its server. */
  extras: Record<string, string>;
}

/** What the harness can do to a phone between and during steps (the phone pressures). */
export interface PhoneTab extends DriverTab {
  /** Stops the app's process, as Android does to an app it needs the memory from, or a crash. */
  kill(): Promise<void>;
  /** Opens the app again, from its launcher icon. */
  reopen(): Promise<void>;
  /** Sends the app to the background (Home). */
  background(): Promise<void>;
  /** Turns the phone to landscape, or back to portrait. */
  rotate(landscape: boolean): Promise<void>;
  /** Turns airplane mode on or off. */
  online(on: boolean): Promise<void>;
}

/** Apps on Android phones: each user gets a phone from the run's lease, each phone runs the app once. */
export class AndroidDriver implements Driver {
  private readonly sdk: AndroidSdk;
  private readonly appium: Appium;
  private readonly phones: string[];
  private readonly app: AndroidApp;
  private readonly proxy: HttpProxy;

  constructor(options: { sdk: AndroidSdk; appium: Appium; phones: string[]; app: AndroidApp; proxy: HttpProxy }) {
    this.sdk = options.sdk;
    this.appium = options.appium;
    this.phones = [...options.phones];
    this.app = options.app;
    this.proxy = options.proxy;
  }

  async session(user: string, _options: SessionOptions): Promise<DriverSession> {
    const serial = this.phones.shift();
    if (!serial) throw new Error(`no phone left for ${user}: each user needs one, and a phone runs the app once`);
    return new AndroidSession(this.sdk, serial, await this.appium.session(serial), this.app, this.proxy);
  }
}

class AndroidSession implements DriverSession {
  private readonly sdk: AndroidSdk;
  private readonly serial: string;
  private readonly phone: PhoneSession;
  private readonly app: AndroidApp;
  private readonly proxy: HttpProxy;
  private tab?: AndroidTab;
  private port?: number;
  private label?: string;

  constructor(sdk: AndroidSdk, serial: string, phone: PhoneSession, app: AndroidApp, proxy: HttpProxy) {
    this.sdk = sdk;
    this.serial = serial;
    this.phone = phone;
    this.app = app;
    this.proxy = proxy;
  }

  async open(label: string, hooks: TabHooks): Promise<DriverTab> {
    if (this.tab) throw new Error("a phone shows one app: second tabs are for web apps");
    // The phone's own localhost:<port> is this proxy port on the Mac (`adb reverse`), so every
    // call on it is this tab's.
    this.port = await allocatePort();
    this.label = label;
    const url = await this.proxy.listenFor(label, this.port);
    await adb(this.sdk, this.serial, ["reverse", "--remove-all"]);
    await adb(this.sdk, this.serial, ["reverse", `tcp:${this.port}`, `tcp:${this.port}`]);
    const tab = new AndroidTab(this.sdk, this.serial, this.phone, this.app, url, hooks.onAction);
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
    await adb(this.sdk, this.serial, ["reverse", "--remove-all"]).catch(() => undefined);
    if (this.label) await this.proxy.stopListening(this.label).catch(() => undefined);
    if (this.port) releasePort(this.port);
    return false;
  }
}

class AndroidTab implements PhoneTab {
  readonly surface: { ui: PhoneUi };
  private readonly sdk: AndroidSdk;
  private readonly serial: string;
  private readonly phone: PhoneSession;
  private readonly app: AndroidApp;
  /** Where this phone reaches its server. */
  private readonly baseUrl: string;

  constructor(sdk: AndroidSdk, serial: string, phone: PhoneSession, app: AndroidApp, baseUrl: string, hook: ActionHook) {
    this.sdk = sdk;
    this.serial = serial;
    this.phone = phone;
    this.app = app;
    this.baseUrl = baseUrl;
    this.surface = { ui: new Ui(this, hook) };
  }

  /** The phone as every run finds it: the app's data gone, portrait, online, drawing its screen. */
  async reset(): Promise<void> {
    await this.sh(`${DRAWING_ON}; pm clear ${this.app.package}`);
    await this.online(true);
    await this.rotate(false);
    await this.sh("input keyevent KEYCODE_WAKEUP");
  }

  async launch(): Promise<void> {
    const extras = Object.entries(this.app.extras).flatMap(([key, value]) => [
      "--es",
      quote(key),
      quote(expandVars(value, { BASE_URL: this.baseUrl })),
    ]);
    const out = await this.sh(["am", "start", "-W", "-n", quote(this.component()), ...extras].join(" "));
    if (/Error|Exception/.test(out)) throw new Error(`could not start ${this.component()}: ${out.trim().split("\n").pop()}`);
    // `am start -W` returns once the window is up, maybe before it shows anything.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const source = await this.phone.getPageSource().catch(() => "");
      if (source.includes(`package="${this.app.package}"`) && / text="[^"]+"/.test(source)) return;
      await sleep(POLL_MS);
    }
  }

  async kill(): Promise<void> {
    await this.sh(`am force-stop ${this.app.package}`);
  }

  async reopen(): Promise<void> {
    await this.launch();
  }

  async background(): Promise<void> {
    await this.sh("input keyevent KEYCODE_HOME");
  }

  async rotate(landscape: boolean): Promise<void> {
    await this.sh(`settings put system accelerometer_rotation 0 && settings put system user_rotation ${landscape ? 1 : 0}`);
  }

  async online(on: boolean): Promise<void> {
    await this.sh(`cmd connectivity airplane-mode ${on ? "disable" : "enable"}`);
  }

  /** The screen as UiAutomator sees it. */
  async screen(): Promise<Screen> {
    return parseScreen(await this.phone.getPageSource());
  }

  async tapAt(x: number, y: number, twice = false): Promise<void> {
    const tap = [
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: 1 },
      { type: "pointerUp", button: 0 },
    ];
    await this.phone.performActions([
      {
        type: "pointer",
        id: "finger",
        parameters: { pointerType: "touch" },
        actions: [{ type: "pointerMove", duration: 0, x, y }, ...tap, ...(twice ? [{ type: "pause", duration: 1 }, ...tap] : [])],
      },
    ]);
    await this.phone.releaseActions();
  }

  async type(index: number, value: string): Promise<void> {
    await this.phone.$(`android=new UiSelector().className("android.widget.EditText").instance(${index})`).setValue(value);
  }

  async pressBack(): Promise<void> {
    await this.sh("input keyevent KEYCODE_BACK");
  }

  url(): string {
    return `${this.app.package}:`;
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
    return screen && snapshotScreen(screen, "", this.app.package);
  }

  /** `adb exec-out screencap`, made a JPEG like a browser's screenshot. */
  async screenshot(path: string, options: { quality: number; timeoutMs: number }): Promise<boolean> {
    const dir = await mkdtemp(join(tmpdir(), "wt-shot-"));
    try {
      const png = await adbRaw(this.sdk, this.serial, ["exec-out", "screencap", "-p"], { timeoutMs: options.timeoutMs });
      if (png.length < 8) return false;
      const file = join(dir, "screen.png");
      await writeFile(file, png);
      await sh(`sips -s format jpeg -s formatOptions ${Math.round(options.quality)} --resampleHeightWidthMax 800 ${quote(file)} --out ${quote(path)}`, {
        cwd: dir,
        timeoutMs: options.timeoutMs,
      });
      return true;
    } catch {
      return false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await this.kill().catch(() => undefined);
    await this.online(true).catch(() => undefined);
    await this.rotate(false).catch(() => undefined);
  }

  private component(): string {
    const activity = this.app.activity.startsWith(".") ? `${this.app.package}${this.app.activity}` : this.app.activity;
    return `${this.app.package}/${activity}`;
  }

  private sh(command: string): Promise<string> {
    return shell(this.sdk, this.serial, command);
  }
}

/** The flow's `ui`: each action waits for its target, then goes through the tab's action hook. */
class Ui implements PhoneUi {
  private readonly tab: AndroidTab;
  private readonly hook: ActionHook;

  constructor(tab: AndroidTab, hook: ActionHook) {
    this.tab = tab;
    this.hook = hook;
  }

  tap(label: string, options: { timeout?: number } = {}): Promise<void> {
    const find = () => this.until(options.timeout, `tap "${label}"`, (screen) => findControl(screen, label));
    return this.hook({
      method: "tap",
      target: JSON.stringify(label),
      args: [label],
      optionsIndex: 1,
      invoke: async () => {
        const { x, y } = await find();
        await this.tab.tapAt(x, y);
      },
      // Both taps land before the app can react, as on a phone that's busy for a moment.
      double: async () => {
        const { x, y } = await find();
        await this.tab.tapAt(x, y, true);
      },
    }) as Promise<void>;
  }

  fill(label: string, value: string, options: { timeout?: number } = {}): Promise<void> {
    return this.hook({
      method: "fill",
      target: JSON.stringify(label),
      args: [label, value],
      optionsIndex: 2,
      invoke: async () => {
        const { index } = await this.until(options.timeout, `fill "${label}"`, (screen) => findField(screen, label));
        await this.tab.type(index, value);
      },
    }) as Promise<void>;
  }

  async see(text: string | RegExp, options: { timeout?: number } = {}): Promise<string> {
    return this.until(options.timeout, `see ${typeof text === "string" ? JSON.stringify(text) : text}`, (screen) => {
      const found = screenTexts(screen).find((t) => matchesText(t, text));
      return found !== undefined ? { ok: true, value: found } : { ok: false, reason: "not on screen" };
    });
  }

  async shows(text: string | RegExp): Promise<boolean> {
    const screen = await this.tab.screen();
    return screenTexts(screen).some((t) => matchesText(t, text));
  }

  back(): Promise<void> {
    return this.hook({ method: "back", target: "phone", args: [], optionsIndex: 0, invoke: () => this.tab.pressBack() }) as Promise<void>;
  }

  async text(): Promise<string> {
    return screenTexts(await this.tab.screen()).join("\n");
  }

  /** Reads the screen until `look` finds what it wants; the error says what was on screen instead. */
  private async until<T>(
    timeout: number | undefined,
    what: string,
    look: (screen: Screen) => { ok: true; value: T } | { ok: false; reason: string },
  ): Promise<T> {
    const ms = timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + ms;
    let last = "";
    let texts: string[] = [];
    for (;;) {
      const screen = await this.tab.screen().catch((err: Error) => err);
      if (!(screen instanceof Error)) {
        const result = look(screen);
        if (result.ok) return result.value;
        last = result.reason;
        texts = screenTexts(screen);
      } else last = screen.message.split("\n")[0]!;
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    const shown = texts.length ? `; on screen: ${texts.slice(0, 12).map((t) => JSON.stringify(t)).join(", ")}` : "";
    throw new Error(`ui.${what}: Timeout ${ms}ms exceeded (${last})${shown}`);
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

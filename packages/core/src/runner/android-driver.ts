import { DRAWING_ON } from "../android/emulators.ts";
import { adb, adbRaw, type AndroidSdk, shell } from "../android/sdk.ts";
import { parseScreen } from "../android/screen.ts";
import { expandVars } from "../config.ts";
import type { PhoneUi } from "../flow-api.ts";
import type { Appium, PhoneSession } from "../phone/appium.ts";
import { type Screen, type ScreenNode, screenAlerts, screenTexts, snapshotScreen } from "../phone/screen.ts";
import { allocatePort, releasePort } from "../ports.ts";
import type { Driver, DriverSession, DriverTab, ScreenState, Seen, SessionOptions, TabHooks } from "./driver.ts";
import type { ActionHook } from "./instrument.ts";
import { jpegFromPng, type PhoneScreen, type PhoneTab, shellQuote as quote, Ui } from "./phone-ui.ts";
import type { HttpProxy } from "./proxy.ts";
import type { PageSnapshot } from "./snapshot.ts";
import { sleep } from "./time.ts";

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
    return new AndroidSession(this.sdk, serial, await phoneSession(this.appium, serial), this.app, this.proxy);
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

class AndroidTab implements PhoneTab, PhoneScreen {
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

  async type(field: { node: ScreenNode; index: number }, value: string): Promise<void> {
    await this.phone.$(`android=new UiSelector().className("android.widget.EditText").instance(${field.index})`).setValue(value);
  }

  async openLink(url: string, twice = false): Promise<void> {
    const open = `am start -a android.intent.action.VIEW -d ${quote(url)} ${this.app.package}`;
    const out = await this.sh(twice ? `${open}; ${open}` : open);
    if (/Error|Exception/.test(out)) throw new Error(`could not open ${url}: ${out.trim().split("\n").pop()}`);
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
    const png = await adbRaw(this.sdk, this.serial, ["exec-out", "screencap", "-p"], { timeoutMs: options.timeoutMs }).catch(() => undefined);
    return png ? jpegFromPng(png, path, options) : false;
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

/** The phone's UiAutomator2 session, kept for the runner's life. */
async function phoneSession(appium: Appium, serial: string): Promise<PhoneSession> {
  return appium.session(
    serial,
    {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:udid": serial,
      "appium:noReset": true,
      "appium:newCommandTimeout": 0,
      "appium:disableWindowAnimation": true,
      "appium:skipLogcatCapture": true,
      "appium:skipUnlock": true,
      "appium:uiautomator2ServerLaunchTimeout": 120_000,
      "appium:adbExecTimeout": 120_000,
    },
    // Flows wait for what they need themselves; UiAutomator's own wait for an idle screen only slows them.
    { waitForIdleTimeout: 0, waitForSelectorTimeout: 0 },
  );
}

import { type ChildProcess, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { killTree, runScript, sh } from "../exec.ts";
import { withLock } from "../lock.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { exists } from "../project.ts";
import { sleep } from "../runner/time.ts";
import { simctl } from "./simctl.ts";

/** WebDriverAgent's runner app on the simulator. */
const RUNNER_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner";
const START_TIMEOUT_MS = 120_000;

/**
 * WebDriverAgent's Xcode project, from the `appium-webdriveragent` package: the nearest
 * node_modules above `from` that has it (Appium's XCUITest driver ships one too).
 */
export async function findWebDriverAgentSource(from: string): Promise<string | undefined> {
  let dir = from;
  for (;;) {
    for (const candidate of [
      join(dir, "node_modules", "appium-webdriveragent"),
      join(dir, "node_modules", "appium-xcuitest-driver", "node_modules", "appium-webdriveragent"),
    ]) {
      if (await exists(join(candidate, "WebDriverAgent.xcodeproj"))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A WebDriverAgent build for the simulator: its test run description, for `xcodebuild test-without-building`. */
export interface WebDriverAgentBuild {
  version: string;
  xctestrun: string;
}

/** Builds WebDriverAgent for the simulator once per version, into `dir/<version>`. */
export async function buildWebDriverAgent(source: string, dir: string, logFile: string): Promise<WebDriverAgentBuild> {
  const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { version: string };
  const out = join(dir, version);
  const built = async () => {
    const products = join(out, "Build", "Products");
    const file = (await readdir(products).catch(() => [])).find((f) => f.endsWith(".xctestrun"));
    return file ? { version, xctestrun: join(products, file) } : undefined;
  };
  const ready = await built();
  if (ready) return ready;
  await mkdir(dir, { recursive: true });
  return withLock(
    join(dir, `${version}.lock`),
    async () => {
      const again = await built();
      if (again) return again;
      const settings = await leaveOutMissing(source);
      await sh(
        [
          "xcodebuild build-for-testing -quiet -project WebDriverAgent.xcodeproj -scheme WebDriverAgentRunner",
          "-destination 'generic/platform=iOS Simulator'",
          `-derivedDataPath '${out}'`,
          ...settings.map(([k, v]) => `'${k}=${v}'`),
        ].join(" "),
        { cwd: source, logFile, timeoutMs: 15 * 60_000 },
      );
      const result = await built();
      if (!result) throw new Error(`WebDriverAgent built, but left no .xctestrun in ${out}; see ${logFile}`);
      return result;
    },
    20 * 60_000,
  );
}

/**
 * Build settings that leave out what WebDriverAgent copies from Xcode but this Xcode lacks:
 * Xcode 26.0 has no lib_TestingInterop.dylib for the simulator, which WebDriverAgent expects of
 * every Xcode 26. It already leaves the file out for Xcode 16, by the same setting.
 */
async function leaveOutMissing(source: string): Promise<[string, string][]> {
  const developer = (await runScript("xcode-select -p", { cwd: source, timeoutMs: 15_000 })).stdout.trim();
  const xcode = /Xcode (\d+)/.exec((await runScript("xcodebuild -version", { cwd: source, timeoutMs: 30_000 })).stdout)?.[1];
  const pbx = await readFile(join(source, "WebDriverAgent.xcodeproj", "project.pbxproj"), "utf8");
  const key = `WDA_XCTEST_EXCLUDED_${xcode}00`;
  const listed = new RegExp(`${key} = "([^"]*)"`).exec(pbx)?.[1];
  if (!developer || listed === undefined) return [];
  const platform = join(developer, "Platforms", "iPhoneSimulator.platform");
  const missing: string[] = [];
  for (const m of pbx.matchAll(/path = ([^;]+); sourceTree = PLATFORM_DIR;/g)) {
    const path = m[1]!.replace(/^"|"$/g, "");
    const name = basename(path);
    if (!listed.split(/\s+/).includes(name) && !missing.includes(name) && !(await exists(join(platform, path)))) missing.push(name);
  }
  return missing.length ? [[key, `${listed} ${missing.join(" ")}`]] : [];
}

/** An element WebDriverAgent found. */
type ElementRef = { ELEMENT?: string; "element-6066-11e4-a52e-4f735466cecf"?: string };

/**
 * WebDriverAgent running on one simulator, the XCTest server that reads its screen and
 * touches it, and its one session. Started with `xcodebuild test-without-building`, which runs
 * it in the simulator without Simulator.app; spoken to over HTTP, with no Appium in between.
 */
export class WebDriverAgent {
  readonly url: string;
  private readonly child: ChildProcess;
  private readonly udid: string;
  /** This Mac's ports it listens on (a simulator shares its network): its server, and its screen stream. */
  private readonly ports: number[];
  private sessionId?: string;
  /** The app the session reads, unless it is set to SpringBoard for a moment. */
  private app?: string;

  private constructor(child: ChildProcess, udid: string, ports: number[]) {
    this.child = child;
    this.udid = udid;
    this.ports = ports;
    this.url = `http://127.0.0.1:${ports[0]}`;
  }

  /** Starts WebDriverAgent on a booted simulator. */
  static async start(build: WebDriverAgentBuild, options: { udid: string; dir: string; logFile: string }): Promise<WebDriverAgent> {
    await stopWebDriverAgent(options.udid);
    const ports = [await allocatePort(), await allocatePort()];
    // Its test results go here, not into ~/Library/Developer/Xcode/DerivedData.
    const data = join(options.dir, options.udid);
    await rm(data, { recursive: true, force: true });
    await mkdir(dirname(options.logFile), { recursive: true });
    const log = openSync(options.logFile, "a");
    try {
      const child = spawn(
        "xcodebuild",
        ["test-without-building", "-xctestrun", build.xctestrun, "-destination", `id=${options.udid}`, "-derivedDataPath", data],
        {
          stdio: ["ignore", log, log],
          env: { ...process.env, TEST_RUNNER_USE_PORT: String(ports[0]), TEST_RUNNER_MJPEG_SERVER_PORT: String(ports[1]) },
        },
      );
      const agent = new WebDriverAgent(child, options.udid, ports);
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          for (const port of ports) releasePort(port);
          throw new Error(`WebDriverAgent's xcodebuild exited (code ${child.exitCode}); see ${options.logFile}`);
        }
        const ok = await fetch(`${agent.url}/status`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
        if (ok) return agent;
        await sleep(500);
      }
      await agent.stop();
      throw new Error(`WebDriverAgent did not start in ${START_TIMEOUT_MS / 1000} s; see ${options.logFile}`);
    } finally {
      closeSync(log);
    }
  }

  /** Opens the session, reading `app`'s screen. */
  async open(app: string): Promise<void> {
    const created = (await this.request("POST", "/session", {
      capabilities: { alwaysMatch: { shouldWaitForQuiescence: false, maxTypingFrequency: 600 } },
    })) as { sessionId?: string };
    this.sessionId = created.sessionId;
    await this.settings({
      defaultActiveApplication: app,
      // Flows wait for what they need themselves; XCTest's waits for an idle app only slow them.
      waitForIdleTimeout: 0,
      animationCoolOffTimeout: 0,
    });
    this.app = app;
  }

  /** The screen as XCUITest sees it (XML); what's visible is worked out from bounds, which is faster. */
  async source(): Promise<string> {
    return (await this.call("GET", "/source?format=xml&scope=AppiumAUT&excluded_attributes=visible,accessible")) as string;
  }

  /** SpringBoard's screen: the system's alerts over the app. */
  async springboardSource(): Promise<string> {
    await this.settings({ defaultActiveApplication: "com.apple.springboard" });
    try {
      return await this.source();
    } finally {
      await this.settings({ defaultActiveApplication: this.app });
    }
  }

  /** The text of an alert over the app (its own or the system's), if one is up. */
  async alertText(): Promise<string | undefined> {
    const text = await this.call("GET", "/alert/text").catch(() => undefined);
    return typeof text === "string" ? text : undefined;
  }

  /** The first element matching an NSPredicate, e.g. `type == "XCUIElementTypeTextField"`. */
  async find(predicate: string): Promise<string | undefined> {
    const found = (await this.call("POST", "/element", { using: "predicate string", value: predicate }).catch(() => undefined)) as ElementRef | undefined;
    return found?.ELEMENT ?? found?.["element-6066-11e4-a52e-4f735466cecf"];
  }

  /** Types `text` into an element, which takes the keyboard's focus first. */
  async type(element: string, text: string): Promise<void> {
    await this.call("POST", `/element/${element}/value`, { value: [...text], text });
  }

  /** W3C pointer actions. */
  async actions(actions: object[]): Promise<void> {
    await this.call("POST", "/actions", { actions });
  }

  async pressButton(name: "home" | "volumeUp" | "volumeDown"): Promise<void> {
    await this.call("POST", "/wda/pressButton", { name });
  }

  async orientation(orientation: "PORTRAIT" | "LANDSCAPE"): Promise<void> {
    await this.call("POST", "/orientation", { orientation });
  }

  async stop(): Promise<void> {
    if (this.sessionId) await this.call("DELETE", "").catch(() => undefined);
    this.sessionId = undefined;
    if (this.child.exitCode === null) {
      killTree(this.child, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (this.child.exitCode === null && Date.now() < deadline) await sleep(100);
      if (this.child.exitCode === null) killTree(this.child, "SIGKILL");
    }
    await simctl(["terminate", this.udid, RUNNER_BUNDLE_ID]).catch(() => undefined);
    for (const port of this.ports) releasePort(port);
  }

  private settings(settings: Record<string, unknown>): Promise<unknown> {
    return this.call("POST", "/appium/settings", { settings });
  }

  /** A command of the session. */
  private call(method: "GET" | "POST" | "DELETE", path: string, body?: object): Promise<unknown> {
    if (!this.sessionId) return Promise.reject(new Error("WebDriverAgent has no session"));
    return this.request(method, `/session/${this.sessionId}${path}`, body).then((r) => r.value);
  }

  private async request(method: string, path: string, body?: object): Promise<{ value: unknown; sessionId?: string }> {
    const response = await fetch(this.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const json = (await response.json().catch(() => ({ value: undefined }))) as { value: unknown; sessionId?: string };
    if (!response.ok) {
      const message = (json.value as { message?: string } | undefined)?.message ?? `WebDriverAgent answered ${response.status}`;
      throw new Error(`${method} ${path.replace(/^\/session\/[^/]+/, "")}: ${message.split("\n")[0]}`);
    }
    return { value: json.value, sessionId: json.sessionId ?? (json.value as { sessionId?: string } | undefined)?.sessionId };
  }
}

/** Ends WebDriverAgent on a simulator: a run's leftover, or one a crashed run left behind. */
export async function stopWebDriverAgent(udid: string): Promise<void> {
  await runScript(`pkill -f 'xcodebuild test-without-building .*-destination id=${udid}'`, { cwd: "/", timeoutMs: 15_000 }).catch(() => undefined);
  await simctl(["terminate", udid, RUNNER_BUNDLE_ID]).catch(() => undefined);
}

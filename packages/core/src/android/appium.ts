import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { killTree } from "../exec.ts";
import { allocatePort, releasePort } from "../ports.ts";
import { exists } from "../project.ts";
import { sleep } from "../runner/time.ts";
import type { AndroidSdk } from "./sdk.ts";

/** The part of a webdriverio session Wind Tunnel uses. */
export interface PhoneSession {
  $(selector: string): PhoneElement;
  getPageSource(): Promise<string>;
  getWindowSize(): Promise<{ width: number; height: number }>;
  performActions(actions: object[]): Promise<void>;
  releaseActions(): Promise<void>;
  updateSettings(settings: Record<string, unknown>): Promise<unknown>;
  deleteSession(): Promise<void>;
}

export interface PhoneElement {
  isExisting(): Promise<boolean>;
  click(): Promise<void>;
  setValue(value: string): Promise<void>;
  getText(): Promise<string>;
  getAttribute(name: string): Promise<string | null>;
  getLocation(): Promise<{ x: number; y: number }>;
  getSize(): Promise<{ width: number; height: number }>;
}

/**
 * Where Appium and its UiAutomator2 driver are installed: the nearest folder above the project
 * with `node_modules/appium` (it is also APPIUM_HOME, so drivers installed there are found).
 */
export async function findAppium(from: string): Promise<{ home: string; bin: string } | undefined> {
  let dir = from;
  for (;;) {
    const bin = join(dir, "node_modules", "appium", "index.js");
    if (await exists(bin)) return { home: dir, bin };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** One Appium server for a runner; one session per phone, kept for the runner's life. */
export class Appium {
  readonly url: string;
  private readonly child: ChildProcess;
  private readonly port: number;
  private readonly home: string;
  private readonly sessions = new Map<string, Promise<PhoneSession>>();

  private constructor(child: ChildProcess, port: number, home: string) {
    this.child = child;
    this.port = port;
    this.home = home;
    this.url = `http://127.0.0.1:${port}`;
  }

  static async start(options: { from: string; sdk: AndroidSdk; logFile: string }): Promise<Appium> {
    const found = await findAppium(options.from);
    if (!found) {
      throw new Error("Appium is not installed: `npm i -D appium appium-uiautomator2-driver webdriverio` in the project (see `windtunnel doctor`)");
    }
    const port = await allocatePort();
    await mkdir(dirname(options.logFile), { recursive: true });
    const log = createWriteStream(options.logFile, { flags: "a" });
    const child = spawn(process.execPath, [found.bin, "server", "--address", "127.0.0.1", "--port", String(port), "--log-level", "warn", "--log-no-colors"], {
      env: { ...process.env, APPIUM_HOME: found.home, ANDROID_HOME: options.sdk.root, ANDROID_SDK_ROOT: options.sdk.root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const appium = new Appium(child, port, found.home);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Appium exited (code ${child.exitCode}); see ${options.logFile}`);
      const ok = await fetch(`${appium.url}/status`).then((r) => r.ok, () => false);
      if (ok) return appium;
      await sleep(250);
    }
    await appium.close();
    throw new Error(`Appium did not start in 60 s; see ${options.logFile}`);
  }

  /** The phone's session, started on first use (the first one installs Appium's server on the phone). */
  session(serial: string): Promise<PhoneSession> {
    let session = this.sessions.get(serial);
    if (!session) {
      session = this.connect(serial);
      this.sessions.set(serial, session);
      session.catch(() => this.sessions.delete(serial));
    }
    return session;
  }

  private async connect(serial: string): Promise<PhoneSession> {
    const require = createRequire(join(this.home, "package.json"));
    const wdio = (await import(pathToFileURL(require.resolve("webdriverio")).href)) as {
      remote(options: object): Promise<PhoneSession>;
    };
    const session = await wdio.remote({
      hostname: "127.0.0.1",
      port: this.port,
      path: "/",
      logLevel: "silent",
      connectionRetryTimeout: 180_000,
      connectionRetryCount: 0,
      capabilities: {
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
    });
    // Flows wait for what they need themselves; UiAutomator's own wait for an idle screen only slows them.
    await session.updateSettings({ waitForIdleTimeout: 0, waitForSelectorTimeout: 0 });
    return session;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) await (await session.catch(() => undefined))?.deleteSession().catch(() => undefined);
    this.sessions.clear();
    if (this.child.exitCode === null) {
      killTree(this.child, "SIGTERM");
      const deadline = Date.now() + 5_000;
      while (this.child.exitCode === null && Date.now() < deadline) await sleep(100);
      if (this.child.exitCode === null) killTree(this.child, "SIGKILL");
    }
    releasePort(this.port);
  }
}

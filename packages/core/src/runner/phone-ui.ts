import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sh } from "../exec.ts";
import type { PhoneUi } from "../flow-api.ts";
import { findControl, findField, matchesText, type Screen, type ScreenNode, screenTexts } from "../phone/screen.ts";
import type { DriverTab } from "./driver.ts";
import type { ActionHook } from "./instrument.ts";
import { sleep } from "./time.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

/** What the harness can do to a phone between and during steps (the phone pressures). */
export interface PhoneTab extends DriverTab {
  /** Stops the app's process, as the phone does to an app it needs the memory from, or a crash. */
  kill(): Promise<void>;
  /** Opens the app again, from its icon. */
  reopen(): Promise<void>;
  /** Sends the app to the background (Home). */
  background(): Promise<void>;
  /** Turns the phone to landscape, or back to portrait. */
  rotate(landscape: boolean): Promise<void>;
  /** Cuts the phone off the network, or connects it again (the proxy also drops its calls meanwhile). */
  online(on: boolean): Promise<void>;
  /** Delivers a push notification to the app (iOS). */
  push?(payload: Record<string, unknown>): Promise<void>;
  /** Copies a file of the app's data folder (with a SQLite file's -wal and -shm) to `dest`; false when there's none (iOS). */
  appFile?(path: string, dest: string): Promise<boolean>;
}

/** What the flow's `ui` needs from a phone. */
export interface PhoneScreen {
  /** The screen as the phone's accessibility tree shows it. */
  screen(): Promise<Screen>;
  /** A tap at a point of the screen; `twice` lands both taps before the app can react. */
  tapAt(x: number, y: number, twice?: boolean): Promise<void>;
  /** Replaces what a text field holds; `index` counts the screen's fields in reading order. */
  type(field: { node: ScreenNode; index: number }, value: string): Promise<void>;
  pressBack(): Promise<void>;
  /** Opens a link with the app, as tapping it in another app does; `twice` opens it twice in a row. */
  openLink(url: string, twice?: boolean): Promise<void>;
}

/** The flow's `ui`: each action waits for its target, then goes through the tab's action hook. */
export class Ui implements PhoneUi {
  private readonly tab: PhoneScreen;
  private readonly hook: ActionHook;

  constructor(tab: PhoneScreen, hook: ActionHook) {
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
        const field = await this.until(options.timeout, `fill "${label}"`, (screen) => findField(screen, label));
        await this.tab.type(field, value);
      },
    }) as Promise<void>;
  }

  openLink(url: string): Promise<void> {
    return this.hook({
      method: "openLink",
      target: JSON.stringify(url),
      args: [url],
      optionsIndex: 1,
      invoke: () => this.tab.openLink(url),
      // The link arrives twice before the app has handled the first, as when it's tapped twice.
      double: () => this.tab.openLink(url, true),
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

/** A phone's PNG screenshot as a JPEG like a browser's: at most 800 pixels on its long side. */
export async function jpegFromPng(png: Buffer, path: string, options: { quality: number; timeoutMs: number }): Promise<boolean> {
  if (png.length < 8) return false;
  const dir = await mkdtemp(join(tmpdir(), "wt-shot-"));
  try {
    const file = join(dir, "screen.png");
    await writeFile(file, png);
    await sh(`sips -s format jpeg -s formatOptions ${Math.round(options.quality)} --resampleHeightWidthMax 800 ${shellQuote(file)} --out ${shellQuote(path)}`, {
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

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

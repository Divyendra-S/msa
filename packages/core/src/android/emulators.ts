import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, closeSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withLock } from "../lock.ts";
import { exists } from "../project.ts";
import { sleep } from "../runner/time.ts";
import { AdbError, adb, type AndroidSdk, avdHome, shell } from "./sdk.ts";

/**
 * Console ports Wind Tunnel boots its emulators on (`emulator-5570`, `emulator-5572`…): the top
 * of the range adb looks in (up to 5584), away from Android Studio's, which starts at 5554.
 */
const FIRST_PORT = 5570;
const PORTS = 8;
/** The snapshot every run boots from: booted once, animations off, screen kept on. */
const SNAPSHOT = "windtunnel";
const BOOT_TIMEOUT_MS = 240_000;

/** Headless, read-only, from the prepared snapshot: no window, no sound, nothing saved back. */
function bootArgs(avd: string, port: number): string[] {
  return ["-avd", avd, "-port", String(port), "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-skip-adb-auth"];
}

/**
 * The emulators of one AVD that runs use, kept running between runs: `windtunnel devices stop`
 * shuts them down. Each run leases as many as it has users, and gets them back clean.
 */
export class Emulators {
  readonly sdk: AndroidSdk;
  readonly avd: string;
  readonly max: number;
  private readonly logDir: string;
  private started?: Promise<void>;
  private readonly free: string[] = [];
  private readonly queue: { n: number; grant: (serials: string[]) => void }[] = [];
  /** The APK each phone has, as far as this process knows. */
  private readonly installed = new Map<string, string>();

  constructor(sdk: AndroidSdk, options: { avd: string; max: number; logDir: string }) {
    this.sdk = sdk;
    this.avd = options.avd;
    this.max = options.max;
    this.logDir = options.logDir;
  }

  /** `n` phones for one run; give them back with `release`. Waits while other runs hold them. */
  async acquire(n: number): Promise<string[]> {
    if (n > this.max) throw new AdbError(`this experiment needs ${n} phones; android.devices allows ${this.max}`);
    this.started ??= this.start();
    await this.started;
    return new Promise((grant) => {
      this.queue.push({ n, grant });
      this.pump();
    });
  }

  /** Puts the app on a phone, unless this build is already there. */
  async install(serial: string, apk: string, pkg: string): Promise<void> {
    if (this.installed.get(serial) === apk) return;
    await ensureInstalled(this.sdk, serial, apk, pkg);
    this.installed.set(serial, apk);
  }

  release(serials: string[]): void {
    this.free.push(...serials);
    this.pump();
  }

  /** First come, first served: a run waiting for two phones isn't overtaken by runs that need one. */
  private pump(): void {
    while (this.queue.length > 0 && this.free.length >= this.queue[0]!.n) {
      const next = this.queue.shift()!;
      next.grant(this.free.splice(0, next.n));
    }
  }

  /** Finds the AVD's emulators already running and boots the rest, up to `max`. */
  private async start(): Promise<void> {
    await this.prepareSnapshot();
    const running = await runningEmulators(this.sdk, this.avd);
    const ports = new Set((await connectedSerials(this.sdk)).map(portOf));
    const toBoot: number[] = [];
    for (let i = 0; i < PORTS && running.length + toBoot.length < this.max; i++) {
      const port = FIRST_PORT + 2 * i;
      if (!ports.has(port)) toBoot.push(port);
    }
    const booted = await Promise.all(toBoot.map((port) => this.boot(port, ["-read-only", "-snapshot", SNAPSHOT, "-no-snapshot-save"])));
    this.free.push(...running.slice(0, this.max), ...booted);
  }

  /** Boots once to make the snapshot runs start from, unless the AVD has it. */
  private async prepareSnapshot(): Promise<void> {
    const avdDir = join(avdHome(), `${this.avd}.avd`);
    if (!(await exists(join(avdHome(), `${this.avd}.ini`)))) {
      throw new AdbError(`no AVD named ${this.avd}: create it with \`windtunnel devices create\``);
    }
    if (await exists(join(avdDir, "snapshots", SNAPSHOT))) return;
    await mkdir(this.logDir, { recursive: true });
    await withLock(join(this.logDir, `${this.avd}.snapshot.lock`), async () => {
      if (await exists(join(avdDir, "snapshots", SNAPSHOT))) return;
      const port = FIRST_PORT + 2 * (PORTS - 1);
      const serial = await this.boot(port, ["-no-snapshot-load", "-no-snapshot-save"]);
      try {
        await settle(this.sdk, serial);
        await adb(this.sdk, serial, ["emu", "avd", "snapshot", "save", SNAPSHOT], { timeoutMs: 120_000 });
      } finally {
        await stopEmulator(this.sdk, serial);
      }
    });
  }

  /** Starts an emulator on `port` and waits until Android has finished booting. */
  private async boot(port: number, extra: string[]): Promise<string> {
    const serial = `emulator-${port}`;
    await mkdir(this.logDir, { recursive: true });
    const log = openSync(join(this.logDir, `${serial}.log`), "a");
    try {
      const child = spawn(this.sdk.emulator, [...bootArgs(this.avd, port), ...extra], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, ANDROID_HOME: this.sdk.root, ANDROID_SDK_ROOT: this.sdk.root },
      });
      child.unref();
      let exited: number | null | undefined;
      child.once("exit", (code) => (exited = code));
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (exited !== undefined) throw new AdbError(`the emulator exited (code ${exited}); see ${join(this.logDir, `${serial}.log`)}`);
        const booted = await shell(this.sdk, serial, "getprop sys.boot_completed", 5_000).catch(() => "");
        if (booted.trim() === "1") return serial;
        await sleep(1_000);
      }
      await stopEmulator(this.sdk, serial);
      throw new AdbError(`${serial} did not finish booting in ${BOOT_TIMEOUT_MS / 1000} s`);
    } finally {
      closeSync(log);
    }
  }
}

/**
 * Settings every snapshot has: no animations, no rotation by the sensor, the screen always on
 * and unlocked, and apps drawing their screens (test images turn drawing off to save work, which
 * leaves screenshots black).
 */
async function settle(sdk: AndroidSdk, serial: string): Promise<void> {
  const commands = [
    DRAWING_ON,
    "settings put global window_animation_scale 0",
    "settings put global transition_animation_scale 0",
    "settings put global animator_duration_scale 0",
    "settings put system accelerometer_rotation 0",
    "settings put system user_rotation 0",
    "settings put system screen_off_timeout 2147483647",
    "svc power stayon true",
    "locksettings set-disabled true",
    "input keyevent KEYCODE_WAKEUP",
    "input keyevent KEYCODE_HOME",
  ];
  for (const command of commands) await shell(sdk, serial, command).catch(() => undefined);
}

/** Apps started after this draw their screens, on the test images that turn drawing off. */
export const DRAWING_ON = "setprop debug.hwui.drawing_enabled 1";

export async function stopEmulator(sdk: AndroidSdk, serial: string): Promise<void> {
  await adb(sdk, serial, ["emu", "kill"], { timeoutMs: 15_000 }).catch(() => undefined);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await connectedSerials(sdk)).includes(serial)) await sleep(500);
}

/** Serials adb sees, booted or not. */
export async function connectedSerials(sdk: AndroidSdk): Promise<string[]> {
  const out = await adb(sdk, undefined, ["devices"], { timeoutMs: 15_000 }).catch(() => "");
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && parts[1]!.trim() !== "")
    .map((parts) => parts[0]!.trim());
}

/** Emulators of `avd` on Wind Tunnel's ports. */
export async function runningEmulators(sdk: AndroidSdk, avd?: string): Promise<string[]> {
  const ours = (await connectedSerials(sdk)).filter((s) => {
    const port = portOf(s);
    return port >= FIRST_PORT && port < FIRST_PORT + 2 * PORTS;
  });
  const result: string[] = [];
  for (const serial of ours) {
    const name = (await adb(sdk, serial, ["emu", "avd", "name"], { timeoutMs: 5_000 }).catch(() => "")).split("\n")[0]!.trim();
    if (!avd || name === avd) result.push(serial);
  }
  return result;
}

function portOf(serial: string): number {
  const m = /^emulator-(\d+)$/.exec(serial);
  return m ? Number(m[1]) : -1;
}

/** Installs the APK unless the phone already has this exact build. */
export async function ensureInstalled(sdk: AndroidSdk, serial: string, apk: string, pkg: string): Promise<boolean> {
  const local = createHash("sha256").update(await readFile(apk)).digest("hex");
  const path = (await shell(sdk, serial, `pm path ${pkg}`).catch(() => "")).match(/^package:(.*base\.apk)$/m)?.[1];
  if (path) {
    const remote = (await shell(sdk, serial, `sha256sum ${path}`).catch(() => "")).split(/\s+/)[0];
    if (remote === local) return false;
  }
  await adb(sdk, serial, ["install", "-r", "-t", apk], { timeoutMs: 180_000 });
  return true;
}

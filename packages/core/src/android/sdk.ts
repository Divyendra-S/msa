import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exists } from "../project.ts";

/** The Android SDK this machine has: the tools Wind Tunnel runs from it. */
export interface AndroidSdk {
  root: string;
  adb: string;
  emulator: string;
}

/** $ANDROID_HOME, $ANDROID_SDK_ROOT, or where Android Studio puts the SDK. */
export async function findAndroidSdk(env: NodeJS.ProcessEnv = process.env): Promise<AndroidSdk | undefined> {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "Android", "Sdk")];
  for (const root of candidates) {
    if (!root) continue;
    const adb = join(root, "platform-tools", "adb");
    if (await exists(adb)) return { root, adb, emulator: join(root, "emulator", "emulator") };
  }
  return undefined;
}

export class AdbError extends Error {
  override name = "AdbError";
}

/** Runs an SDK tool and returns its output; `serial` picks the device (`adb -s`). */
export function adb(
  sdk: AndroidSdk,
  serial: string | undefined,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  return adbRaw(sdk, serial, args, options).then((out) => out.toString("utf8"));
}

export function adbRaw(sdk: AndroidSdk, serial: string | undefined, args: string[], options: { timeoutMs?: number } = {}): Promise<Buffer> {
  const full = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(
      sdk.adb,
      full,
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr.toString() || stdout.toString() || err.message).trim().split("\n").slice(-3).join(" ");
          reject(new AdbError(`adb ${full.join(" ")}: ${detail}`));
        } else resolve(stdout);
      },
    );
  });
}

/** Runs a shell command on the device; adb reports its exit status only through the output, so failures are text. */
export function shell(sdk: AndroidSdk, serial: string, command: string, timeoutMs?: number): Promise<string> {
  return adb(sdk, serial, ["shell", command], { timeoutMs });
}

/** Where AVDs live: $ANDROID_AVD_HOME, or `avd` under $ANDROID_USER_HOME / $ANDROID_EMULATOR_HOME / ~/.android. */
export function avdHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  return join(env.ANDROID_USER_HOME ?? env.ANDROID_EMULATOR_HOME ?? join(homedir(), ".android"), "avd");
}

export async function listAvds(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const files = await readdir(avdHome(env)).catch(() => [] as string[]);
  return files.filter((f) => f.endsWith(".ini")).map((f) => f.slice(0, -4)).sort();
}

/** `system-images;android-34;google_atd;arm64-v8a` → its folder in the SDK, when installed. */
export async function systemImageDir(sdk: AndroidSdk, image: string): Promise<string | undefined> {
  const dir = join(sdk.root, ...image.split(";"));
  return (await exists(join(dir, "system.img"))) ? dir : undefined;
}

/** Installed system images, as `system-images;android-34;google_atd;arm64-v8a`. */
export async function listSystemImages(sdk: AndroidSdk): Promise<string[]> {
  const found: string[] = [];
  const base = join(sdk.root, "system-images");
  for (const api of await readdir(base).catch(() => [] as string[])) {
    for (const tag of await readdir(join(base, api)).catch(() => [] as string[])) {
      for (const abi of await readdir(join(base, api, tag)).catch(() => [] as string[])) {
        const image = ["system-images", api, tag, abi].join(";");
        if (await systemImageDir(sdk, image)) found.push(image);
      }
    }
  }
  return found.sort();
}

/** The AVD Wind Tunnel makes when asked: a small phone on Android's image for automated tests. */
export const DEFAULT_AVD = "windtunnel-34";
export const DEFAULT_IMAGE = "system-images;android-34;google_atd;arm64-v8a";

/**
 * Writes an AVD for a system image, as Android Studio's device manager would: a 720×1600 phone,
 * no audio or cameras, 2 GB of memory. Fails if it already exists.
 */
export async function createAvd(sdk: AndroidSdk, name: string, image: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const imageDir = await systemImageDir(sdk, image);
  if (!imageDir) throw new AdbError(`system image ${image} is not installed in ${sdk.root}`);
  const home = avdHome(env);
  const dir = join(home, `${name}.avd`);
  if ((await exists(dir)) || (await exists(join(home, `${name}.ini`)))) throw new AdbError(`AVD ${name} already exists (${dir})`);
  const [, platform, tag, abi] = image.split(";") as [string, string, string, string];
  const props = await readFile(join(imageDir, "source.properties"), "utf8").catch(() => "");
  const tagDisplay = /^SystemImage\.TagDisplay=(.*)$/m.exec(props)?.[1] ?? tag;
  const config: Record<string, string> = {
    AvdId: name,
    "avd.ini.displayname": `Wind Tunnel (${platform})`,
    "avd.ini.encoding": "UTF-8",
    "abi.type": abi,
    "hw.cpu.arch": abi.startsWith("arm64") ? "arm64" : abi.startsWith("x86_64") ? "x86_64" : abi,
    "hw.cpu.ncore": "2",
    "hw.ramSize": "2048",
    "vm.heapSize": "256",
    "disk.dataPartition.size": "4G",
    "hw.lcd.width": "720",
    "hw.lcd.height": "1600",
    "hw.lcd.density": "320",
    "hw.keyboard": "yes",
    "hw.mainKeys": "no",
    "hw.accelerometer": "yes",
    "hw.sensors.orientation": "yes",
    "hw.audioInput": "no",
    "hw.audioOutput": "no",
    "hw.camera.back": "none",
    "hw.camera.front": "none",
    "hw.gps": "no",
    "hw.sdCard": "no",
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": "swiftshader_indirect",
    "showDeviceFrame": "no",
    "PlayStore.enabled": "false",
    "image.sysdir.1": `${image.split(";").join("/")}/`,
    "tag.id": tag,
    "tag.display": tagDisplay,
    target: platform,
  };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.ini"), `${Object.entries(config).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
  await writeFile(join(home, `${name}.ini`), `avd.ini.encoding=UTF-8\npath=${dir}\npath.rel=avd/${name}.avd\ntarget=${platform}\n`);
  return dir;
}

import { execFile } from "node:child_process";

/** Simulators Wind Tunnel makes and runs are named `windtunnel-iphone-1`, `windtunnel-iphone-2`… */
export const SIMULATOR_PREFIX = "windtunnel-iphone";
/** The phone they are, the first of these the runtime has. */
export const DEVICE_TYPES = ["iPhone 17", "iPhone 16", "iPhone 16e", "iPhone 15"];

export class SimctlError extends Error {
  override name = "SimctlError";
}

/** Runs `xcrun simctl`; returns its output. `env` reaches a launched app (simctl's SIMCTL_CHILD_ variables). */
export function simctl(args: string[], options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<string> {
  return simctlRaw(args, options).then((out) => out.toString("utf8"));
}

export function simctlRaw(args: string[], options: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<Buffer> {
  const env = options.env ? { ...process.env, ...Object.fromEntries(Object.entries(options.env).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v])) } : process.env;
  return new Promise((resolve, reject) => {
    execFile(
      "xcrun",
      ["simctl", ...args],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 60_000, env },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr.toString() || stdout.toString() || err.message).trim().split("\n").slice(-3).join(" ");
          reject(new SimctlError(`simctl ${args.join(" ")}: ${detail}`));
        } else resolve(stdout);
      },
    );
  });
}

export interface SimRuntime {
  identifier: string;
  /** `26.0.1` */
  version: string;
  name: string;
  isAvailable: boolean;
  supportedDeviceTypes: { name: string; identifier: string }[];
}

export interface Simulator {
  udid: string;
  name: string;
  /** `Booted`, `Shutdown`… */
  state: string;
  isAvailable: boolean;
  /** The runtime's identifier. */
  runtime: string;
}

/** The iOS simulator runtimes Xcode has, newest first. */
export async function iosRuntimes(): Promise<SimRuntime[]> {
  const out = JSON.parse(await simctl(["list", "runtimes", "-j"])) as { runtimes: (SimRuntime & { platform?: string })[] };
  return out.runtimes
    .filter((r) => (r.platform ?? r.name.split(" ")[0]) === "iOS" && r.isAvailable)
    .sort((a, b) => compareVersions(b.version, a.version));
}

export async function listSimulators(): Promise<Simulator[]> {
  const out = JSON.parse(await simctl(["list", "devices", "-j"])) as { devices: Record<string, Omit<Simulator, "runtime">[]> };
  return Object.entries(out.devices).flatMap(([runtime, devices]) => devices.map((d) => ({ ...d, runtime })));
}

/** Wind Tunnel's simulators, in name order. */
export async function windtunnelSimulators(): Promise<Simulator[]> {
  const all = await listSimulators();
  return all
    .filter((s) => s.isAvailable && s.name.startsWith(`${SIMULATOR_PREFIX}-`))
    .sort((a, b) => simulatorNumber(a.name) - simulatorNumber(b.name));
}

function simulatorNumber(name: string): number {
  return Number(name.slice(SIMULATOR_PREFIX.length + 1)) || 0;
}

/**
 * Makes Wind Tunnel's simulators, up to `count`, on the newest iOS runtime: the ones already
 * there are kept. Returns the names made.
 */
export async function createSimulators(count: number): Promise<{ created: string[]; runtime: SimRuntime; deviceType: string }> {
  const runtime = (await iosRuntimes())[0];
  if (!runtime) throw new SimctlError("no iOS simulator runtime: install one with `xcodebuild -downloadPlatform iOS` (about 8 GB)");
  const supported = new Map(runtime.supportedDeviceTypes.map((t) => [t.name, t.identifier]));
  const name = DEVICE_TYPES.find((t) => supported.has(t)) ?? runtime.supportedDeviceTypes.find((t) => t.name.startsWith("iPhone"))?.name;
  if (!name) throw new SimctlError(`iOS ${runtime.version} has no iPhone to simulate`);
  const have = new Set((await windtunnelSimulators()).map((s) => s.name));
  const created: string[] = [];
  for (let i = 1; i <= count; i++) {
    const simName = `${SIMULATOR_PREFIX}-${i}`;
    if (have.has(simName)) continue;
    await simctl(["create", simName, supported.get(name)!, runtime.identifier]);
    created.push(simName);
  }
  return { created, runtime, deviceType: name };
}

/** Boots a simulator without Simulator.app (no window) and waits until iOS has started. */
export async function bootSimulator(udid: string, timeoutMs = 240_000): Promise<void> {
  await simctl(["boot", udid], { timeoutMs }).catch((err: Error) => {
    if (!/current state: Booted/.test(err.message)) throw err;
  });
  await simctl(["bootstatus", udid, "-b"], { timeoutMs });
}

export async function shutdownSimulator(udid: string): Promise<void> {
  await simctl(["shutdown", udid], { timeoutMs: 60_000 }).catch((err: Error) => {
    if (!/current state: Shutdown/.test(err.message)) throw err;
  });
}

/** Where an installed app keeps its data on this Mac: its Documents, Library and tmp. */
export async function appDataContainer(udid: string, bundleId: string): Promise<string> {
  return (await simctl(["get_app_container", udid, bundleId, "data"])).trim();
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

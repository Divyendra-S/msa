import { DevicePool } from "../phone/pool.ts";
import { bootSimulator, SimctlError, shutdownSimulator, SIMULATOR_PREFIX, windtunnelSimulators } from "./simctl.ts";
import { stopWebDriverAgent } from "./wda.ts";

/**
 * Wind Tunnel's simulators that runs use, booted without Simulator.app and kept running between
 * runs: `windtunnel devices stop` shuts them down. Each run leases as many as it has users.
 */
export class Simulators {
  readonly max: number;
  private readonly pool: DevicePool;

  constructor(options: { max: number }) {
    this.max = options.max;
    this.pool = new DevicePool(options.max, () => this.start());
  }

  /** `n` simulators (their UDIDs) for one run; give them back with `release`. */
  acquire(n: number): Promise<string[]> {
    return this.pool.acquire(n, () => new SimctlError(`this experiment needs ${n} phones; ios.devices allows ${this.max}`));
  }

  release(udids: string[]): void {
    this.pool.release(udids);
  }

  /** Boots the first `max` of Wind Tunnel's simulators, unless they're running already. */
  private async start(): Promise<string[]> {
    const simulators = (await windtunnelSimulators()).slice(0, this.max);
    if (simulators.length === 0) throw new SimctlError(`no ${SIMULATOR_PREFIX}-… simulators: create them with \`windtunnel devices create\``);
    await Promise.all(simulators.map((s) => bootSimulator(s.udid)));
    return simulators.map((s) => s.udid);
  }
}

/** Shuts down Wind Tunnel's running simulators, and WebDriverAgent on them; returns their names. */
export async function stopSimulators(): Promise<string[]> {
  const running = (await windtunnelSimulators()).filter((s) => s.state === "Booted");
  await Promise.all(running.map(async (s) => {
    await stopWebDriverAgent(s.udid);
    await shutdownSimulator(s.udid);
  }));
  return running.map((s) => s.name);
}

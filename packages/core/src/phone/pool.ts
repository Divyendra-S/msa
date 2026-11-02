/**
 * Phones shared by a runner's runs: each run leases as many as it has users and gives them back
 * when it's done. The phones start on the first lease.
 */
export class DevicePool {
  readonly max: number;
  private readonly start: () => Promise<string[]>;
  private started?: Promise<void>;
  private readonly free: string[] = [];
  private readonly queue: { n: number; grant: (ids: string[]) => void }[] = [];

  /** `start` finds or boots the phones, at most `max` of them. */
  constructor(max: number, start: () => Promise<string[]>) {
    this.max = max;
    this.start = start;
  }

  /** `n` phones for one run; give them back with `release`. Waits while other runs hold them. */
  async acquire(n: number, tooMany: () => Error): Promise<string[]> {
    if (n > this.max) throw tooMany();
    this.started ??= this.start().then((ids) => void this.free.push(...ids.slice(0, this.max)));
    await this.started;
    return new Promise((grant) => {
      this.queue.push({ n, grant });
      this.pump();
    });
  }

  release(ids: string[]): void {
    this.free.push(...ids);
    this.pump();
  }

  /** First come, first served: a run waiting for two phones isn't overtaken by runs that need one. */
  private pump(): void {
    while (this.queue.length > 0 && this.free.length >= this.queue[0]!.n) {
      const next = this.queue.shift()!;
      next.grant(this.free.splice(0, next.n));
    }
  }
}

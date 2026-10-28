import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Append stdout and stderr to this file as well. */
  logFile?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  output: string;
}

export class CommandError extends Error {
  override name = "CommandError";
  readonly command: string;
  readonly result: RunResult;
  readonly logFile?: string;

  constructor(command: string, result: RunResult, logFile?: string) {
    const tail = result.output.trim().split("\n").slice(-20).join("\n");
    super(`command failed (exit ${result.code}): ${command}${logFile ? `\nlog: ${logFile}` : ""}\n${tail}`);
    this.command = command;
    this.result = result;
    this.logFile = logFile;
  }
}

/** Runs a shell command to completion. Throws CommandError on a non-zero exit. */
export async function sh(command: string, options: RunOptions): Promise<RunResult> {
  const log = options.logFile ? await openLog(options.logFile, command) : undefined;
  const child = spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const chunks: string[] = [];
  const collect = (data: Buffer) => {
    chunks.push(data.toString("utf8"));
    log?.write(data);
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);

  const timer = options.timeoutMs
    ? setTimeout(() => killTree(child, "SIGKILL"), options.timeoutMs).unref()
    : undefined;
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
  await closeLog(log);

  const result = { code, output: chunks.join("") };
  if (code !== 0) throw new CommandError(command, result, options.logFile);
  return result;
}

/** A long-running process (an app server) whose whole process tree can be stopped. */
export class Service {
  readonly command: string;
  readonly exited: Promise<number | null>;
  private readonly child: ChildProcess;
  private readonly log: WriteStream;
  private stopped = false;

  private constructor(command: string, child: ChildProcess, log: WriteStream) {
    this.command = command;
    this.child = child;
    this.log = log;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  static async start(command: string, options: RunOptions & { logFile: string }): Promise<Service> {
    const log = await openLog(options.logFile, command);
    const child = spawn(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group, so stop() also reaches anything the shell started.
      detached: process.platform !== "win32",
    });
    child.stdout!.pipe(log, { end: false });
    child.stderr!.pipe(log, { end: false });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    return new Service(command, child, log);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  async stop(graceMs = 3_000): Promise<void> {
    if (this.stopped) return this.exited.then(() => undefined);
    this.stopped = true;
    if (this.running) {
      killTree(this.child, "SIGTERM");
      const timer = setTimeout(() => killTree(this.child, "SIGKILL"), graceMs);
      await this.exited;
      clearTimeout(timer);
    }
    await closeLog(this.log);
  }
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  killPid(child.pid, signal);
}

/** Kills a process group started by sh() or Service (falls back to the single pid). */
export function killPid(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

async function openLog(path: string, command: string): Promise<WriteStream> {
  await mkdir(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: "a" });
  stream.write(`\n$ ${command}\n`);
  return stream;
}

function closeLog(stream: WriteStream | undefined): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve();
  return new Promise((resolve) => stream.end(resolve));
}

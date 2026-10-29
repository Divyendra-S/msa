import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

export interface RunJob {
  id: string;
  /** Experiment ids; empty for every experiment. */
  experiments: string[];
  repeat?: number;
  startedAt: string;
  endedAt?: string;
  /** done: the run finished, whatever its experiments found · failed: the CLI stopped on an error. */
  status: "running" | "done" | "failed" | "stopped";
  exitCode?: number | null;
  /** The CLI's last error line, when it stopped on one. */
  error?: string;
  /** The last lines of its output (stdout and stderr). */
  output: string[];
}

const MAX_OUTPUT = 200;
const MAX_JOBS = 20;
/** The run needs no model: no agent's credentials reach it. */
const FOREIGN_ENV = /^(ANTHROPIC_|CLAUDE_|CLAUDECODE|OPENAI_|CODEX_)/;
const ID = /^[\w][\w.-]*$/;

/**
 * `windtunnel run` started from the viewer (the Mac app's Run button): the CLI in a child process,
 * one at a time, kept in memory. Its runs reach the viewer through the store, like any other.
 */
export class RunJobs {
  private readonly jobs: RunJob[] = [];
  private current?: { job: RunJob; child: ChildProcess };
  private readonly listeners = new Set<(id: string, line?: string, info?: RunJob) => void>();

  private readonly root: string;
  private readonly cli?: string[];
  private readonly env: NodeJS.ProcessEnv;

  constructor(root: string, cli: string[] | undefined, env: NodeJS.ProcessEnv = process.env) {
    this.root = root;
    this.cli = cli;
    this.env = env;
  }

  /** Called with each output line, and with the job when its status changes. */
  subscribe(listener: (id: string, line?: string, info?: RunJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  running(): RunJob | undefined {
    return this.current?.job;
  }

  /** Newest first. */
  list(): RunJob[] {
    return [...this.jobs].reverse();
  }

  start(input: { experiments?: unknown; repeat?: unknown }): RunJob {
    const cli = this.cli;
    if (!cli?.length) throw new JobError(501, "this viewer can't start runs: start it with windtunnel view");
    if (this.current) throw new JobError(409, `a run (${this.current.job.id}) is still going`);
    const experiments = input.experiments ?? [];
    if (!Array.isArray(experiments) || !experiments.every((e) => typeof e === "string" && ID.test(e))) {
      throw new JobError(400, "experiments: a list of experiment ids");
    }
    const repeat = input.repeat;
    if (repeat !== undefined && !(Number.isInteger(repeat) && (repeat as number) >= 1 && (repeat as number) <= 50)) {
      throw new JobError(400, "repeat: a whole number from 1 to 50");
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 14);
    const job: RunJob = {
      id: `${stamp.slice(0, 6)}-${stamp.slice(6)}-${randomBytes(2).toString("hex")}`,
      experiments: experiments as string[],
      ...(repeat !== undefined ? { repeat: repeat as number } : {}),
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
    };
    const args = [...cli.slice(1), "run", ...job.experiments, ...(job.repeat ? ["--repeat", String(job.repeat)] : []), "--cwd", this.root];
    const env = Object.fromEntries(Object.entries(this.env).filter(([k]) => !FOREIGN_ENV.test(k)));
    const child = spawn(cli[0]!, args, { cwd: this.root, env, stdio: ["ignore", "pipe", "pipe"] });
    const current = { job, child };
    this.current = current;
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.shift();
    this.emit(job.id, undefined, job);

    const push = (line: string) => {
      job.output.push(line);
      if (job.output.length > MAX_OUTPUT) job.output.shift();
      this.emit(job.id, line);
    };
    createInterface({ input: child.stdout! }).on("line", (line) => push(line));
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.startsWith("error: ")) job.error = line.slice(7);
      push(line);
    });
    const finish = (code: number | null, error?: string) => {
      if (this.current !== current) return;
      if (error) {
        job.error = error;
        push(error);
      }
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      // Exit 1 is also "an experiment didn't pass": only an error line makes it a failure.
      if (job.status === "running") job.status = (code === 0 || code === 1) && !job.error ? "done" : "failed";
      this.current = undefined;
      this.emit(job.id, undefined, job);
    };
    child.on("error", (err) => finish(null, `could not start ${cli[0]}: ${err.message}`));
    child.on("close", (code) => finish(code));
    return job;
  }

  /** Asks the run to stop (SIGINT: the CLI stops its apps and drops their databases), then insists. */
  stop(id: string): boolean {
    const current = this.current;
    if (!current || current.job.id !== id) return false;
    current.job.status = "stopped";
    current.child.kill("SIGINT");
    const kill = setTimeout(() => current.child.kill("SIGKILL"), 15_000);
    current.child.once("close", () => clearTimeout(kill));
    return true;
  }

  /** Stops a running job; for shutting the viewer down. */
  async close(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.stop(current.job.id);
    await new Promise<void>((resolve) => {
      if (current.child.exitCode !== null || current.child.signalCode !== null) return resolve();
      current.child.once("close", () => resolve());
    });
  }

  private emit(id: string, line?: string, info?: RunJob): void {
    for (const l of this.listeners) l(id, line, info);
  }
}

export class JobError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

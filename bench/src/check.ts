// Day-0 check of the Muse setup, run in the Muse shell (source scripts/muse-env.sh):
//
//   pnpm bench check           free: Muse Code installed, the `muse exec` flags the benchmark uses, the key
//   pnpm bench check --paid    also one Muse Spark decision and one short Muse Code run on Spark (a few cents):
//                              the JSONL events (usage), its sandbox reaching Postgres and local ports, and
//                              the skills and MCP server it finds under a HOME of its own, as in a trial
//
// Everything the paid run printed is kept in $TMPDIR/windtunnel-muse-check/ for a look at the events.
import { execFile, spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { MuseSpark } from "@windtunnel/explorer";
import { addUsage, readEvent } from "@windtunnel/viewer";
import { REPO_ROOT } from "./cases.ts";
import { MUSE_COMMAND } from "./hosts.ts";

const exec = promisify(execFile);
const CLI = join(REPO_ROOT, "packages", "cli", "src", "bin.ts");
const SPARK = "muse-spark-1.3";
const PG_PORT = 55432;

interface Result {
  name: string;
  ok: boolean | undefined;
  detail: string;
}

export async function checkMuse(options: { paid: boolean; model?: string }): Promise<number> {
  const results: Result[] = [];
  const say = (r: Result) => {
    results.push(r);
    console.log(`${r.ok === undefined ? "??  " : r.ok ? "ok  " : "FAIL"}  ${r.name.padEnd(24)} ${r.detail}`);
  };

  const version = await exec("muse", ["--version"]).then((r) => r.stdout.trim(), () => undefined);
  say({ name: "muse", ok: !!version, detail: version ?? "not on PATH: install Muse Code (dev.meta.ai/docs/muse-code)" });
  if (!version) return 1;

  const help = await exec("muse", ["exec", "--help"]).then((r) => r.stdout + r.stderr, (e) => `${e.stdout ?? ""}${e.stderr ?? ""}`);
  for (const flag of MUSE_COMMAND.filter((a) => a.startsWith("--"))) {
    say({ name: `exec ${flag}`, ok: help.includes(flag), detail: help.includes(flag) ? "listed" : "not in `muse exec --help`: fix MUSE_COMMAND in bench/src/hosts.ts" });
  }

  const key = process.env.MODEL_API_KEY;
  say({ name: "MODEL_API_KEY", ok: !!key, detail: key ? `set${process.env.META_API_KEY === key ? " (and META_API_KEY)" : ""}` : "not set: source scripts/muse-env.sh" });
  if (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_BASE_URL.includes("meta.ai")) {
    say({ name: "shell", ok: false, detail: `ANTHROPIC_BASE_URL is ${process.env.ANTHROPIC_BASE_URL}: this isn't a clean Muse shell` });
  }
  if (!options.paid || !key) {
    if (!options.paid) console.log("\nThe paid checks (one Spark decision, one short Muse Code run on Spark): pnpm bench check --paid");
    return results.every((r) => r.ok !== false) ? 0 : 1;
  }

  // One Level 1 decision, as Wind Tunnel asks them.
  try {
    const started = Date.now();
    const reply = await new MuseSpark(process.env.WINDTUNNEL_SPARK_URL ?? "https://api.meta.ai/v1", SPARK, key).ask(
      {
        kind: "check",
        ask: "Which control is the button that pays for the cart?",
        context: ["The flow clicked a button named 'Pay now', which is gone.", "Buttons on the page now: 'Place order', 'Continue shopping', 'Sign out'."],
        options: { place: "Place order", continue: "Continue shopping", signout: "Sign out" },
      },
      AbortSignal.timeout(30_000),
    );
    say({
      name: "Spark decision",
      ok: reply.choice === "place",
      detail: `${reply.choice} at ${reply.confidence.toFixed(2)} in ${Date.now() - started} ms · ${reply.inputTokens} in / ${reply.outputTokens} out · $${(reply.usd ?? 0).toFixed(5)}`,
    });
  } catch (err) {
    say({ name: "Spark decision", ok: false, detail: (err as Error).message });
  }

  // One short headless run, set up like a benchmark trial: its own HOME with the MCP server and
  // the skills, the key in META_API_KEY, other agents' variables removed.
  const dir = join(tmpdir(), "windtunnel-muse-check");
  await rm(dir, { recursive: true, force: true });
  const app = join(dir, "app");
  const home = join(dir, "home");
  await mkdir(app, { recursive: true });
  await mkdir(join(home, ".config", "muse"), { recursive: true });
  await exec("git", ["init", "-q"], { cwd: app });
  await writeFile(join(app, "README.md"), "Setup check.\n");
  await writeFile(
    join(home, ".config", "muse", "settings.json"),
    `${JSON.stringify({ schema_version: 1, mcp_servers: { windtunnel: { transport: "stdio", command: process.execPath, args: [CLI, "mcp"], env: { WINDTUNNEL_DECIDER: "rules" } } } }, null, 2)}\n`,
  );
  await exec(process.execPath, [CLI, "skills", "--out", join(home, ".agents", "skills"), "--prefix", "windtunnel-"]);

  const server = createServer((_req, res) => res.end("pong-7f3a")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const pgUp = await new Promise<boolean>((resolve) => {
    const s = connect({ host: "127.0.0.1", port: PG_PORT, timeout: 1000 });
    s.once("connect", () => (s.destroy(), resolve(true))).once("error", () => resolve(false)).once("timeout", () => (s.destroy(), resolve(false)));
  });
  const prompt = join(dir, "prompt.md");
  await writeFile(
    prompt,
    [
      "This is a setup check. Do exactly these three things, then stop. Don't change any files.",
      "",
      // The markers are joined at run time, so a copy of the prompt in the events doesn't count.
      `1. Run: node -e "require('net').connect(${PG_PORT},'127.0.0.1').on('connect',()=>{console.log(['pg','reachable'].join('-'));process.exit(0)}).on('error',e=>{console.log(['pg','error'].join('-')+' '+e.code);process.exit(1)})"`,
      `2. Run: curl -s http://127.0.0.1:${port}/`,
      "3. Reply with one line, `skills:` then the names of your skills that start with windtunnel-, then `tools:` then the names of your MCP tools that start with windtunnel.",
    ].join("\n"),
  );

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|OPENAI_|CODEX_)/.test(k)) env[k] = v;
  const real = homedir();
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    META_API_KEY: env.META_API_KEY ?? key,
    PLAYWRIGHT_BROWSERS_PATH: env.PLAYWRIGHT_BROWSERS_PATH ?? join(real, process.platform === "darwin" ? "Library/Caches" : ".cache", "ms-playwright"),
  });
  const command = MUSE_COMMAND.map((a) => a.replace("{max_steps}", "8").replace("{model}", options.model ?? SPARK).replace("{prompt_file}", prompt));
  console.log(`\n${command.join(" ")}   (in ${app}, HOME=${home})`);
  const started = Date.now();
  const child = spawn(command[0]!, command.slice(1), { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let stderr = "";
  const usage = { input: 0, output: 0, cached: 0, usd: 0 };
  const texts: string[] = [];
  let parsed = 0;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(line);
    let value: unknown;
    try {
      value = JSON.parse(line);
      parsed++;
    } catch {
      texts.push(line);
      return;
    }
    const e = readEvent(value);
    if (e.usage) addUsage(usage, e.usage, e.type);
    if (e.text) texts.push(e.text);
    // Command output may sit in fields readEvent doesn't show; the raw line has it.
    texts.push(line);
  });
  child.stderr!.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill("SIGINT"), 180_000);
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", (err) => ((stderr += err.message), resolve(null)));
    child.once("exit", resolve);
  });
  clearTimeout(timer);
  server.close();
  await writeFile(join(dir, "events.jsonl"), `${lines.join("\n")}\n`);
  await writeFile(join(dir, "stderr.log"), stderr);
  const all = texts.join("\n");

  say({ name: "headless run", ok: code === 0, detail: `exit ${code} after ${((Date.now() - started) / 1000).toFixed(0)} s${code !== 0 ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}` });
  say({ name: "signed in", ok: code === 0 && !/sign in|log ?in|unauthori[sz]ed|401/i.test(stderr), detail: "with its own HOME and META_API_KEY" });
  say({ name: "JSONL events", ok: parsed > 0 && parsed === lines.filter((l) => l.trim()).length, detail: `${parsed} of ${lines.length} lines are JSON` });
  say({
    name: "usage in events",
    ok: usage.input + usage.output > 0,
    detail: usage.input + usage.output > 0 ? `${usage.input} in / ${usage.output} out / ${usage.cached} cached${usage.usd ? ` · $${usage.usd.toFixed(4)}` : ""}` : "none found: look at events.jsonl and teach readEvent the usage field",
  });
  say({
    name: "sandbox → pg",
    ok: all.includes("pg-reachable") ? true : all.includes("pg-error") ? false : undefined,
    detail: all.includes("pg-reachable") ? `reached 127.0.0.1:${PG_PORT}` : all.includes("pg-error") ? `blocked (${/pg-error (\w+)/.exec(all)?.[1]})` : pgUp ? "no answer in the events" : `Postgres isn't running on ${PG_PORT}: pnpm db:up, then check again`,
  });
  say({ name: "sandbox → port", ok: all.includes("pong-7f3a") ? true : undefined, detail: all.includes("pong-7f3a") ? `reached 127.0.0.1:${port}` : "no answer in the events" });
  const skills = ["init", "hunt", "prove", "test"].filter((s) => all.includes(`windtunnel-${s}`));
  say({ name: "skills (~/.agents)", ok: skills.length === 4 ? true : undefined, detail: skills.length ? `saw windtunnel-${skills.join(", windtunnel-")}` : "not mentioned: check where Muse Code looks for user skills" });
  say({ name: "MCP server", ok: all.includes("windtunnel_run") ? true : undefined, detail: all.includes("windtunnel_run") ? "its tools are listed" : "not mentioned: check ~/.config/muse/settings.json handling" });
  console.log(`\nevents: ${join(dir, "events.jsonl")}\n?? = the run didn't say; read the events to decide.`);
  return results.every((r) => r.ok !== false) ? 0 : 1;
}

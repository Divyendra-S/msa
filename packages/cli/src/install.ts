import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromiumStatus, playwrightCli } from "@windtunnel/core";
import { FROM_SOURCE, PACKAGE_ROOT, PLUGIN_DIR, writeSkills } from "./skills.ts";

/** The npm package (`windtunnel` and the `@windtunnel` scope belong to other projects). */
export const PACKAGE_NAME = "windtunnel-cli";
export const HOSTS = ["claude", "codex", "muse"] as const;
export type Host = (typeof HOSTS)[number];
const HOST_NAMES: Record<Host, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse Code" };
const PG_PORTS = [5432, 55432];
const PG_CONTAINER = "windtunnel-pg";

export interface InstallOptions {
  /** Don't ask before making changes. */
  yes?: boolean;
  /** Only print what would be done. */
  dryRun?: boolean;
  /** Only these agents (default: every one found). */
  hosts?: Host[];
  env?: NodeJS.ProcessEnv;
  out?: (text: string) => void;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Step {
  title: string;
  /** The commands or files, shown before asking. */
  detail: string[];
  run(): Promise<void>;
}

/**
 * `windtunnel install`: checks Node, git, Docker, Postgres and Playwright's Chromium, puts the CLI
 * on PATH (from npx), and adds the plugin to each coding agent it finds: Claude Code and Codex
 * through their plugin marketplaces (pointed at this package's folder), Muse Code through its
 * settings file and skills folder. Asks once before changing anything.
 */
export async function install(options: InstallOptions = {}): Promise<number> {
  const env = options.env ?? process.env;
  const out = options.out ?? ((text: string) => process.stdout.write(`${text}\n`));
  const checks: Check[] = [];
  const steps: Step[] = [];
  const notes: string[] = [];

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 18);
  checks.push({ name: "node", ok: nodeOk, detail: `v${process.versions.node} (need 22.18+)` });
  const git = await capture("git", ["--version"], env);
  checks.push({ name: "git", ok: git.code === 0, detail: git.code === 0 ? git.stdout.trim() : "not found" });

  const docker = await capture("docker", ["info", "--format", "{{.ServerVersion}}"], env);
  const dockerOk = docker.code === 0 && docker.stdout.trim() !== "";
  checks.push({ name: "docker", ok: dockerOk, detail: dockerOk ? `server ${docker.stdout.trim()}` : "not running (only needed for the Postgres below)" });

  const pgPorts = (await Promise.all(PG_PORTS.map(async (port) => ((await listening(port)) ? port : undefined)))).filter((p) => p !== undefined);
  checks.push({
    name: "postgres",
    ok: pgPorts.length > 0,
    detail: pgPorts.length ? `listening on ${pgPorts.map((p) => `127.0.0.1:${p}`).join(", ")}` : `nothing on ${PG_PORTS.join(" or ")}`,
  });
  if (!pgPorts.length && dockerOk) {
    const exists = (await capture("docker", ["container", "inspect", PG_CONTAINER], env)).code === 0;
    const args = exists
      ? ["start", PG_CONTAINER]
      : ["run", "-d", "--name", PG_CONTAINER, "-p", "55432:5432", "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"];
    steps.push({
      title: "Start Postgres 17 in Docker on port 55432 (for apps without their own)",
      detail: [`docker ${args.join(" ")}`],
      run: () => mustRun("docker", args, env),
    });
  } else if (!pgPorts.length) {
    notes.push("No Postgres found. Start your app's own, or Docker and run this again for one on port 55432.");
  }

  const browser = chromiumStatus();
  checks.push({ name: "chromium", ok: browser.installed, detail: browser.installed ? "Playwright's Chromium is installed" : "not downloaded yet" });
  if (!browser.installed) {
    steps.push({
      title: "Download Playwright's Chromium (about 150 MB)",
      detail: ["playwright install chromium"],
      run: () => mustRun(process.execPath, [playwrightCli(), "install", "chromium"], env, true),
    });
  }

  // The skills run `windtunnel` in the agent's shell, so it must be on PATH, and the plugin
  // marketplaces need a folder that stays put: a global install, not npx's cache.
  let source = PACKAGE_ROOT;
  let sourceLabel = PACKAGE_ROOT;
  const onPath = await which("windtunnel", env);
  if (FROM_SOURCE) {
    if (!onPath) notes.push(`\`windtunnel\` isn't on PATH. From this checkout: pnpm --dir ${join(PACKAGE_ROOT, "packages", "cli")} link --global`);
  } else {
    const installed = onPath ? await packageOf(onPath) : undefined;
    const ours = (await readJson(join(PACKAGE_ROOT, "package.json"))) as { version: string };
    if (installed && installed.version === ours.version && !installed.dir.includes(`${sep}_npx${sep}`)) {
      source = sourceLabel = installed.dir;
    } else {
      sourceLabel = `<npm root -g>/${PACKAGE_NAME}`;
      const npm = existsSync(join(dirname(process.execPath), "npm")) ? join(dirname(process.execPath), "npm") : "npm";
      const spec = `${PACKAGE_NAME}@${ours.version}`;
      steps.push({
        title: `Install the CLI for good (\`windtunnel\` on PATH)`,
        detail: [`npm install -g ${spec}`],
        run: async () => {
          await mustRun(npm, ["install", "-g", spec], env, true);
          source = join((await capture(npm, ["root", "-g"], env)).stdout.trim(), PACKAGE_NAME);
        },
      });
    }
  }

  const found: Host[] = [];
  for (const host of options.hosts ?? HOSTS) {
    if (await which(host, env)) found.push(host);
    else if (options.hosts) notes.push(`${HOST_NAMES[host]} (\`${host}\`) not found on PATH.`);
  }
  if (found.includes("claude")) {
    steps.push({
      title: "Claude Code: add the Wind Tunnel plugin",
      detail: [`claude plugin marketplace add ${sourceLabel}`, "claude plugin install windtunnel@windtunnel"],
      run: async () => {
        await mustRun("claude", ["plugin", "marketplace", "add", source], env);
        await mustRun("claude", ["plugin", "install", "windtunnel@windtunnel"], env);
      },
    });
  }
  if (found.includes("codex")) {
    steps.push({
      title: "Codex: add the Wind Tunnel plugin",
      detail: [`codex plugin marketplace add ${sourceLabel}`, "codex plugin add windtunnel@windtunnel"],
      run: async () => {
        const added = await capture("codex", ["plugin", "marketplace", "add", source], env);
        if (added.code !== 0) {
          // Added before from another folder (an older install, a checkout): point it here.
          if (!/already added/i.test(added.stderr + added.stdout)) throw new Error(`codex plugin marketplace add: ${(added.stderr || added.stdout).trim()}`);
          await mustRun("codex", ["plugin", "marketplace", "remove", "windtunnel"], env);
          await mustRun("codex", ["plugin", "marketplace", "add", source], env);
        }
        await mustRun("codex", ["plugin", "add", "windtunnel@windtunnel"], env);
      },
    });
  }
  if (found.includes("muse")) {
    const home = env.HOME ?? homedir();
    const settings = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "muse", "settings.json");
    const skillsDir = join(home, ".agents", "skills");
    steps.push({
      title: "Muse Code: add the skills and the MCP server",
      detail: [`skills → ${join(skillsDir, "windtunnel-*")}`, `mcp_servers.windtunnel → ${settings}`],
      run: async () => {
        await writeSkills(skillsDir, "windtunnel-");
        await addMuseServer(settings, onPath || !FROM_SOURCE ? "windtunnel" : join(PLUGIN_DIR, "scripts", "mcp.sh"));
      },
    });
  }
  const missing = HOSTS.filter((h) => !found.includes(h) && !options.hosts);
  if (!found.length) notes.push("No coding agent found (claude, codex or muse on PATH). Install one and run this again.");
  else if (missing.length) notes.push(`Not found: ${missing.map((h) => HOST_NAMES[h]).join(", ")}. Run this again after installing.`);

  out("Wind Tunnel install\n");
  out(checks.map((c) => `  ${c.ok ? "ok  " : "--  "}  ${c.name.padEnd(9)} ${c.detail}`).join("\n"));
  if (!nodeOk || git.code !== 0) {
    out(`\n${!nodeOk ? "Node 22.18 or newer is needed" : "git is needed"}: install it, then run this again.`);
    return 1;
  }
  if (notes.length) out(`\n${notes.join("\n")}`);
  if (!steps.length) {
    out("\nNothing to do: everything is set up.");
    if (found.length) out(nextSteps(found));
    return 0;
  }
  out(`\nTo do\n${steps.map((s, i) => `  ${i + 1}. ${s.title}\n${s.detail.map((d) => `       ${d}`).join("\n")}`).join("\n")}`);
  if (options.dryRun) return 0;
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      out("\nRun again with --yes to do this.");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("\nGo ahead? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (answer && answer !== "y" && answer !== "yes") return 1;
  }

  let failed = 0;
  for (const [i, step] of steps.entries()) {
    out(`\n${i + 1}. ${step.title}`);
    try {
      await step.run();
      out("   done");
    } catch (err) {
      failed++;
      out(`   failed: ${(err as Error).message}`);
    }
  }
  if (found.length) out(nextSteps(found));
  return failed ? 1 : 0;
}

function nextSteps(hosts: Host[]): string {
  const how: Record<Host, string> = {
    claude: "Claude Code: start `claude`, then /windtunnel:init",
    codex: "Codex: start `codex`, then ask for the windtunnel init skill",
    muse: "Muse Code: start `muse`, then ask for the windtunnel-init skill",
  };
  return `\nNext, in your app's folder:\n${hosts.map((h) => `  ${how[h]}`).join("\n")}`;
}

/** Adds the server to Muse Code's settings, keeping everything else (and a backup of the file). */
async function addMuseServer(file: string, command: string): Promise<void> {
  let settings: { schema_version?: number; mcp_servers?: Record<string, unknown> } = {};
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text !== undefined) {
    try {
      settings = JSON.parse(text);
    } catch {
      throw new Error(`${file} isn't valid JSON: add the server by hand (see plugins/muse-code/README.md)`);
    }
    if (!existsSync(`${file}.windtunnel-backup`)) await copyFile(file, `${file}.windtunnel-backup`);
  }
  settings.schema_version ??= 1;
  settings.mcp_servers = { ...settings.mcp_servers, windtunnel: { transport: "stdio", command, args: command.endsWith(".sh") ? [] : ["mcp"] } };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** The first executable named `command` on PATH. */
export async function which(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const file = join(dir, command);
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return undefined;
}

/** The npm package a `windtunnel` on PATH belongs to. */
async function packageOf(bin: string): Promise<{ dir: string; version: string } | undefined> {
  let dir = dirname(await realpath(bin));
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const pkg = (await readJson(join(dir, "package.json")).catch(() => undefined)) as { name?: string; version?: string } | undefined;
    if (pkg?.name === PACKAGE_NAME && pkg.version) return { dir, version: pkg.version };
  }
  return undefined;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 500 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true)).once("error", () => done(false)).once("timeout", () => done(false));
  });
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.once("error", () => resolve({ code: 127, stdout, stderr }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Runs a command; its output is shown only on failure, unless `show` (downloads print progress). */
async function mustRun(command: string, args: string[], env: NodeJS.ProcessEnv, show = false): Promise<void> {
  if (show) {
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command, args, { env, stdio: "inherit" });
      child.once("error", () => resolve(127));
      child.once("close", (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${code}`);
    return;
  }
  const result = await capture(command, args, env);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
}

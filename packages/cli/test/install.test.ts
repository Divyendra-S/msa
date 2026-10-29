import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { install } from "../src/install.ts";
import { PACKAGE_ROOT, PLUGIN_DIR } from "../src/skills.ts";

test("install adds the plugin to every agent found and keeps Muse Code's other settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wt-install-"));
  try {
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    const log = join(dir, "calls.log");
    await mkdir(bin, { recursive: true });
    const shim = async (name: string, body = "") => {
      await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\nexit 0\n`);
      await chmod(join(bin, name), 0o755);
    };
    await shim("claude");
    // Codex refuses a marketplace added before from another folder: install points it here.
    await shim(
      "codex",
      `if [ "$3" = add ] && [ ! -f "${dir}/codex-moved" ]; then touch "${dir}/codex-moved"; echo "Error: marketplace 'windtunnel' is already added from a different source" >&2; exit 1; fi`,
    );
    await shim("muse");
    await shim("docker", `[ "$1" = info ] && echo 27.0.0`);
    const settings = join(home, ".config", "muse", "settings.json");
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(settings, JSON.stringify({ schema_version: 1, model: "muse-wonder-1.0", mcp_servers: { other: { transport: "stdio", command: "other" } } }));

    const out: string[] = [];
    const env = { PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: home, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
    const code = await install({ yes: true, env, out: (text) => out.push(text) });
    assert.equal(code, 0, out.join("\n"));

    const calls = (await readFile(log, "utf8")).trim().split("\n").filter((c) => !c.startsWith("docker"));
    assert.deepEqual(calls, [
      `claude plugin marketplace add ${PACKAGE_ROOT}`,
      "claude plugin install windtunnel@windtunnel",
      `codex plugin marketplace add ${PACKAGE_ROOT}`,
      "codex plugin marketplace remove windtunnel",
      `codex plugin marketplace add ${PACKAGE_ROOT}`,
      "codex plugin add windtunnel@windtunnel",
    ]);

    const saved = JSON.parse(await readFile(settings, "utf8"));
    assert.equal(saved.model, "muse-wonder-1.0");
    assert.equal(saved.mcp_servers.other.command, "other");
    // From a checkout, with no `windtunnel` on PATH: the plugin's launcher, which finds the CLI.
    assert.deepEqual(saved.mcp_servers.windtunnel, { transport: "stdio", command: join(PLUGIN_DIR, "scripts", "mcp.sh"), args: [] });
    assert.equal(JSON.parse(await readFile(`${settings}.windtunnel-backup`, "utf8")).mcp_servers.windtunnel, undefined);
    assert.deepEqual((await readdir(join(home, ".agents", "skills"))).sort(), ["windtunnel-hunt", "windtunnel-init", "windtunnel-prove", "windtunnel-test"]);
    assert.match(await readFile(join(home, ".agents", "skills", "windtunnel-hunt", "SKILL.md"), "utf8"), /^name: windtunnel-hunt$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("install --dry-run changes nothing and --hosts names missing agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wt-install-"));
  try {
    const out: string[] = [];
    const env = { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter), HOME: dir, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };
    const code = await install({ dryRun: true, hosts: ["muse"], env, out: (text) => out.push(text) });
    assert.equal(code, 0);
    assert.match(out.join("\n"), /Muse Code \(`muse`\) not found on PATH/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

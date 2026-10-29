// Makes the demo app: the Bug Zoo shop with three bugs at once (double submit, duplicate webhook,
// oversell: demo.patch), as a one-commit repository outside this one, with Wind Tunnel set up as
// after /windtunnel:init (the config and the login flow; the agent writes rules and experiments).
// See docs/demo.md.
//
//   node zoo/demo/setup.ts [--dir <folder>] [--force] [--no-install]
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REPO = join(import.meta.dirname, "..", "..");
const SHOP = join(REPO, "zoo", "shop");
const { values } = parseArgs({
  options: {
    dir: { type: "string", default: join(tmpdir(), "windtunnel-demo") },
    force: { type: "boolean", default: false },
    "no-install": { type: "boolean", default: false },
  },
});
const dir = resolve(values.dir!);
const app = join(dir, "shop");
const bin = join(dir, "bin");
if (dir.startsWith(REPO)) throw new Error(`put the demo outside this repository (${REPO}), so the agent can't read the answers`);
if (existsSync(dir)) {
  if (!values.force) throw new Error(`${dir} exists: --force replaces it`);
  await rm(dir, { recursive: true, force: true });
}

const git = (args: string[]) =>
  exec("git", args, {
    cwd: app,
    env: { ...process.env, GIT_AUTHOR_NAME: "Shop", GIT_AUTHOR_EMAIL: "shop@example.test", GIT_COMMITTER_NAME: "Shop", GIT_COMMITTER_EMAIL: "shop@example.test" },
  });

const { stdout } = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "."], { cwd: SHOP, maxBuffer: 16 * 1024 * 1024 });
const keep = (f: string) => !f.startsWith(".windtunnel/") || f === ".windtunnel/.gitignore" || f === ".windtunnel/flows/login.ts";
for (const file of stdout.split("\0").filter((f) => f && keep(f) && existsSync(join(SHOP, f)))) {
  await mkdir(dirname(join(app, file)), { recursive: true });
  await copyFile(join(SHOP, file), join(app, file));
}
await git(["init", "-q", "-b", "main"]);
await git(["apply", "-p3", join(import.meta.dirname, "demo.patch")]);
await git(["add", "-A"]);
await git(["commit", "-q", "-m", "Shop"]);

// mock-pay for scripts/local.mjs, and the checkout's CLI when `windtunnel` isn't installed.
await mkdir(bin, { recursive: true });
const shim = async (name: string, script: string) => {
  await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(join(bin, name), 0o755);
};
await shim("mock-pay", join(REPO, "zoo", "mock-pay", "src", "bin.ts"));
await shim("windtunnel", join(REPO, "packages", "cli", "src", "bin.ts"));

if (!values["no-install"]) {
  console.log("Installing the shop's packages…");
  await exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-workspace", "--reporter=silent"], { cwd: app, maxBuffer: 16 * 1024 * 1024 });
}

console.log(`Demo shop: ${app}
Bugs: double submit (two orders for one cart), duplicate webhook (payment recorded twice),
oversell (stock below zero). Wind Tunnel: config and login flow only.

In a terminal of its own (Muse Code, billed to the Meta key):
  source ${join(REPO, "scripts", "muse-env.sh")}
  export PATH="${bin}:$PATH"
  cd ${app}
  windtunnel prepare        # build the app and the seed snapshot once, so the first run is quick
  windtunnel view           # then Run hunt

Or in Claude Code, on your own login:
  export PATH="${bin}:$PATH"; cd ${app}
  claude --plugin-dir ${join(REPO, "plugins", "windtunnel")}     # then /windtunnel:hunt checkout`);

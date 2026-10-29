// Builds the npm package of the CLI into packages/cli/pkg/: the code bundled into dist/ (Node
// doesn't strip types from files in node_modules), the viewer's UI in ui/, the plugin in plugin/,
// and the marketplace files, so Claude Code and Codex can install the plugin from the package.
//
//   node packages/cli/build.ts            then: cd packages/cli/pkg && npm pack (or npm publish)
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { build } from "rolldown";
import { PACKAGE_NAME } from "./src/install.ts";

const CLI_DIR = import.meta.dirname;
const REPO = join(CLI_DIR, "..", "..");
const OUT = join(CLI_DIR, "pkg");
const WORKSPACE = ["core", "explorer", "mcp", "viewer"].map((name) => join(REPO, "packages", name));

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const cli = await readJson(join(CLI_DIR, "package.json"));

// Third-party dependencies of the bundled workspace packages stay dependencies of the package.
const dependencies: Record<string, string> = {};
for (const dir of WORKSPACE) {
  for (const [name, version] of Object.entries((await readJson(join(dir, "package.json"))).dependencies ?? {})) {
    if (!String(version).startsWith("workspace:")) dependencies[name] = String(version);
  }
}
// Vite only builds the UI in a checkout; the package ships it built.
const external = (id: string) =>
  id.startsWith("node:") || builtinModules.includes(id) || [...Object.keys(dependencies), "vite"].some((d) => id === d || id.startsWith(`${d}/`));

await rm(OUT, { recursive: true, force: true });
await build({
  input: { bin: join(CLI_DIR, "src", "bin.ts"), "flow-api": join(REPO, "packages", "core", "src", "flow-api.ts") },
  platform: "node",
  external,
  logLevel: "warn",
  output: { dir: join(OUT, "dist"), format: "esm", entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
});

// The viewer's UI, built if it's missing or older than its sources.
const viewer = await import("@windtunnel/viewer");
if ((await viewer.uiStatus()) !== "ok") await viewer.buildUi();
await cp(join(REPO, "packages", "viewer", "dist"), join(OUT, "ui"), { recursive: true });

await cp(join(REPO, "plugins", "windtunnel"), join(OUT, "plugin"), { recursive: true });
for (const file of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
  const text = await readFile(join(REPO, file), "utf8");
  await mkdir(dirname(join(OUT, file)), { recursive: true });
  await writeFile(join(OUT, file), text.replaceAll("./plugins/windtunnel", "./plugin"));
}
await cp(join(REPO, "LICENSE"), join(OUT, "LICENSE"));
await cp(join(CLI_DIR, "README.md"), join(OUT, "README.md"));

const pkg = {
  name: PACKAGE_NAME,
  version: cli.version,
  description: cli.description,
  license: cli.license,
  type: "module",
  bin: { windtunnel: "dist/bin.js" },
  engines: { node: ">=22.18" },
  repository: { type: "git", url: "git+https://github.com/Divyendra-S/msa.git" },
  keywords: ["testing", "playwright", "postgres", "race-conditions", "mcp", "coding-agent"],
  files: ["dist", "ui", "plugin", ".claude-plugin", ".agents", "README.md", "LICENSE"],
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
};
await writeFile(join(OUT, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`${PACKAGE_NAME}@${pkg.version} in ${OUT}`);

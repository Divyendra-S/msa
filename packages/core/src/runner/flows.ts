import { readFile, stat } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "../config.ts";
import { type Flow, isFlow } from "../flow-api.ts";
import { exists } from "../project.ts";

export const FLOWS_DIR = "flows";
export const LOGIN_FLOW = "login";
const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];
const FLOW_API_URL = new URL("../flow-api.ts", import.meta.url).href;

let hooksRegistered = false;
const flowDirs = new Set<string>();

/**
 * Flow files import from "windtunnel". Projects don't have to install it: the
 * import is pointed at this copy. Flow files are always ES modules, whatever the
 * project's package.json says.
 */
function registerFlowImports(stateDir: string): void {
  flowDirs.add(`${pathToFileURL(join(stateDir, FLOWS_DIR)).href}/`);
  if (hooksRegistered) return;
  hooksRegistered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "windtunnel") return { url: FLOW_API_URL, shortCircuit: true };
      const resolved = nextResolve(specifier, context);
      const inFlows = [...flowDirs].some((dir) => resolved.url.startsWith(dir));
      if (inFlows && /\.ts(\?|$)/.test(resolved.url)) return { ...resolved, format: "module-typescript" };
      return resolved;
    },
  });
}

export interface LoadedFlow {
  name: string;
  file: string;
  flow: Flow;
  /** Step names found in the source, for checking experiment files. */
  steps: string[];
}

export async function findFlowFile(stateDir: string, name: string): Promise<string | undefined> {
  for (const ext of EXTENSIONS) {
    const file = join(stateDir, FLOWS_DIR, `${name}${ext}`);
    if (await exists(file)) return file;
  }
  return undefined;
}

/** Imports `.windtunnel/flows/<name>.ts`. Edited files are picked up on the next load. */
export async function loadFlow(stateDir: string, name: string): Promise<LoadedFlow> {
  const file = await findFlowFile(stateDir, name);
  if (!file) throw new ConfigError(`flow "${name}" not found: expected ${join(stateDir, FLOWS_DIR, `${name}.ts`)}`);
  registerFlowImports(stateDir);
  const { mtimeMs } = await stat(file);
  let mod: { default?: unknown };
  try {
    mod = await import(`${pathToFileURL(file).href}?v=${mtimeMs}`);
  } catch (err) {
    throw new ConfigError(`flow "${name}" failed to load (${file}): ${(err as Error).message}`);
  }
  if (!isFlow(mod.default)) {
    throw new ConfigError(`flow "${name}" (${file}) must \`export default flow(async ({ page, step }) => { … })\``);
  }
  return { name, file, flow: mod.default, steps: stepNames(await readFile(file, "utf8")) };
}

/** Literal step names in a flow's source: `step("pay", …)`. */
export function stepNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bstep\(\s*(["'`])([^"'`]+)\1/g)) names.add(m[2]!);
  return [...names];
}

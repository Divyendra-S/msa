import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** A scenario's XCTest method, found in the package's sources. */
export interface ScenarioSource {
  /** What `xctest -XCTest` takes: `RecorderScenarios.RecorderScenarios/testStopWhileWriting`. */
  test: string;
  file: string;
  line: number;
  /** The steps it marks with `Probe.step("…")`, in order. */
  steps: string[];
}

/** A `Probe.point("…")` in the code; `section` when it covers a block (`Probe.point("…") { … }`). */
export interface ProbePoint {
  name: string;
  file: string;
  line: number;
  section: boolean;
}

const SKIP = new Set([".build", ".swiftpm", "build", "node_modules", ".git", "DerivedData"]);

/** The Swift files under `dir`, relative paths with `/`, and their text. */
export async function swiftFiles(dir: string): Promise<{ file: string; text: string }[]> {
  const out: { file: string; text: string }[] = [];
  const walk = async (at: string): Promise<void> => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) await walk(join(at, e.name));
      } else if (e.name.endsWith(".swift")) {
        const path = join(at, e.name);
        out.push({ file: relative(dir, path).split(sep).join("/"), text: await readFile(path, "utf8") });
      }
    }
  };
  await walk(dir);
  return out;
}

/**
 * Finds `Class/testMethod` (or `Module.Class/testMethod`) in the package's tests. The module is
 * the test target: the folder under `Tests/` the class is in.
 */
export async function findScenario(dir: string, scenario: string, files?: { file: string; text: string }[]): Promise<ScenarioSource | undefined> {
  const [qualified, method] = scenario.split("/") as [string, string];
  const parts = qualified.split(".");
  const className = parts.pop()!;
  const module = parts.join(".") || undefined;
  for (const { file, text } of files ?? (await swiftFiles(dir))) {
    const target = /^Tests\/([^/]+)\//.exec(file)?.[1];
    if (!target || (module && module !== target)) continue;
    const code = blankCommentsAndStrings(text);
    const cls = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`).exec(code);
    if (!cls) continue;
    const classEnd = matchBrace(code, cls.index + cls[0].length - 1);
    const fn = new RegExp(`\\bfunc\\s+${method}\\s*\\(`).exec(code.slice(cls.index, classEnd));
    if (!fn) continue;
    const at = cls.index + fn.index;
    const open = code.indexOf("{", at);
    const body = text.slice(open, matchBrace(code, open));
    const steps = [...body.matchAll(/\bProbe\.step\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
    return { test: `${module ?? target}.${className}/${method}`, file, line: lineAt(text, at), steps };
  }
  return undefined;
}

/** Every probe point in the package's code (tests left out). */
export async function probePoints(dir: string, files?: { file: string; text: string }[]): Promise<ProbePoint[]> {
  const out: ProbePoint[] = [];
  for (const { file, text } of files ?? (await swiftFiles(dir))) {
    if (file.startsWith("Tests/")) continue;
    const code = blankComments(text);
    for (const m of code.matchAll(/\bProbe\.point\(\s*"((?:[^"\\]|\\.)*)"\s*\)\s*(\{)?/g)) {
      out.push({ name: m[1]!, file, line: lineAt(text, m.index), section: !!m[2] });
    }
  }
  return out;
}

/** The text with comments blanked out (same length, newlines kept); strings stay, `//` in them too. */
function blankComments(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : m.replace(/[^\n]/g, " ")));
}

/** The text with comments and string contents blanked out, so braces in them don't count. */
function blankCommentsAndStrings(text: string): string {
  return blankComments(text).replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${" ".repeat(m.length - 2)}"`);
}

/** The index just past the brace that closes the one at `open`. */
function matchBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i + 1;
  }
  return code.length;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

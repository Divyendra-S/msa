import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type UiFacts, unique } from "./source.ts";

/** A call the phone app makes to its server, found in its code. */
export interface AndroidCall {
  method: string;
  /** As written, with template parts as `{name}`: `/api/orders/{orderId}`. */
  path: string;
  file: string;
  line: number;
  /** The function it's in: `pay`. */
  fn?: string;
}

export interface AndroidScreen {
  name: string;
  file: string;
  line: number;
  /** What it shows, and the server calls its actions lead to (through the view model, two calls deep). */
  ui: UiFacts;
}

export interface AndroidApp {
  framework: string;
  screens: AndroidScreen[];
  calls: AndroidCall[];
}

const SKIP_DIRS = new Set(["build", ".gradle", ".kotlin", ".idea", ".git", ".windtunnel", "node_modules"]);
const BUTTONS = /\b(?:Button|TextButton|OutlinedButton|ElevatedButton|FilledTonalButton|IconButton|FloatingActionButton|ExtendedFloatingActionButton)\s*\(/g;

/** An Android app's screens and server calls under `root`; undefined when there's no AndroidManifest.xml. */
export async function findAndroidApp(root: string): Promise<AndroidApp | undefined> {
  const manifests = await walk(root, (f) => f.endsWith("AndroidManifest.xml"));
  if (manifests.length === 0) return undefined;
  const gradle = (await Promise.all((await walk(root, (f) => /build\.gradle(\.kts)?$/.test(f))).map((f) => readFile(f, "utf8")))).join("\n");
  const compose = /compose\s*=\s*true|androidx\.compose/.test(gradle);

  const files = await Promise.all(
    (await walk(root, (f) => f.endsWith(".kt"))).sort().map(async (file) => ({ file, text: blankComments(await readFile(file, "utf8")) })),
  );
  const functions = new Map<string, { body: string }[]>();
  const calls: AndroidCall[] = [];
  const screens: { name: string; file: string; line: number; body: string }[] = [];
  for (const { file, text } of files) {
    for (const fn of kotlinFunctions(text)) {
      functions.set(fn.name, [...(functions.get(fn.name) ?? []), { body: fn.body }]);
      if (/@Composable\s+(?:(?:private|internal|public)\s+)?$/.test(text.slice(Math.max(0, fn.start - 60), fn.start)) && /Screen$/.test(fn.name)) {
        screens.push({ name: fn.name, file: relative(root, file), line: lineAt(text, fn.start), body: fn.body });
      }
    }
    for (const call of serverCalls(text)) calls.push({ ...call, file: relative(root, file) });
  }

  return {
    framework: compose ? "Android (Jetpack Compose)" : "Android",
    calls,
    screens: screens.map((s) => ({ name: s.name, file: s.file, line: s.line, ui: { ...screenUi(s.body), requests: reachableCalls(s.body, functions, calls) } })),
  };
}

/** `call("POST", "/api/orders", …)` style helpers and Retrofit's `@POST("api/orders")`. */
function serverCalls(text: string): Omit<AndroidCall, "file">[] {
  const out: Omit<AndroidCall, "file">[] = [];
  const FUN = /\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/g;
  const found = [
    // In a function's body: the function it's in.
    ...[...text.matchAll(/"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"(\/[^"]*)"/g)].map((m) => ({
      at: m.index,
      method: m[1]!,
      path: m[2]!,
      fn: [...text.slice(0, m.index).matchAll(FUN)].at(-1)?.[1],
    })),
    // On a function (Retrofit): the function it annotates.
    ...[...text.matchAll(/@(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]*)"\s*\)/g)].map((m) => ({
      at: m.index,
      method: m[1]!,
      path: `/${m[2]!.replace(/^\//, "")}`,
      fn: new RegExp(FUN.source).exec(text.slice(m.index))?.[1],
    })),
  ];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const fn = f.fn;
    out.push({ method: f.method, path: template(f.path), line: lineAt(text, f.at), ...(fn ? { fn } : {}) });
  }
  return out;
}

/** Buttons (their text and accessibility labels), field labels and texts a screen's code shows. */
function screenUi(body: string): Omit<UiFacts, "requests"> {
  const buttons: string[] = [];
  for (const m of body.matchAll(BUTTONS)) {
    const close = matchParen(body, m.index + m[0].length - 1);
    const args = body.slice(m.index + m[0].length, close);
    const lambda = /^\s*\{/.exec(body.slice(close + 1)) ? body.slice(close + 1, matchBrace(body, body.indexOf("{", close + 1)) + 1) : "";
    for (const s of strings(lambda)) buttons.push(s);
    for (const d of args.matchAll(/contentDescription\s*=\s*("(?:[^"\\]|\\.)*")/g)) buttons.push(template(d[1]!.slice(1, -1)));
  }
  const fields = [...body.matchAll(/\b(?:label|placeholder)\s*=\s*\{\s*Text\(\s*"([^"]+)"/g)].map((m) => template(m[1]!));
  const texts = strings(body).filter((s) => !buttons.includes(s) && !fields.includes(s) && /^[A-Z]|\s\w/.test(s) && !s.startsWith("/"));
  return { buttons: unique(buttons), fields: unique(fields), texts: unique(texts), links: [], redirects: [] };
}

/** Server calls in functions the screen calls, and the functions those call: a screen's actions as far as its view model's API. */
function reachableCalls(body: string, functions: Map<string, { body: string }[]>, calls: AndroidCall[]): { method: string; url: string }[] {
  const reached = new Set<string>();
  let frontier = calledNames(body);
  for (let depth = 0; depth < 2; depth++) {
    const next = new Set<string>();
    for (const name of frontier) {
      if (reached.has(name) || !functions.has(name)) continue;
      reached.add(name);
      for (const fn of functions.get(name)!) for (const n of calledNames(fn.body)) next.add(n);
    }
    frontier = next;
  }
  for (const name of frontier) if (functions.has(name)) reached.add(name);
  return unique(calls.filter((c) => c.fn && reached.has(c.fn)).map((c) => `${c.method} ${c.path}`)).map((s) => {
    const [method, url] = s.split(" ") as [string, string];
    return { method, url };
  });
}

/** Functions a body calls (`api.pay(…)`, `load()`) or passes on (`model::pay`); property reads aren't calls. */
function calledNames(body: string): Set<string> {
  return new Set([...body.matchAll(/::(\w+)\b/g), ...body.matchAll(/(\w+)\s*\(/g)].map((m) => m[1]!));
}

interface KotlinFn {
  name: string;
  start: number;
  body: string;
}

/** Functions with a block body, or an expression body (to the end of its line). */
function kotlinFunctions(text: string): KotlinFn[] {
  const out: KotlinFn[] = [];
  for (const m of text.matchAll(/\bfun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/g)) {
    const close = matchParen(text, m.index + m[0].length - 1);
    const rest = text.slice(close + 1);
    const head = /^[^{=\n]*([{=])/.exec(rest);
    if (!head) continue;
    const at = close + 1 + head[0].length - 1;
    const end = head[1] === "{" ? matchBrace(text, at) : text.indexOf("\n", at) < 0 ? text.length : text.indexOf("\n", at);
    out.push({ name: m[1]!, start: m.index, body: text.slice(at, end + 1) });
  }
  return out;
}

/** String literals' text, templates as `{name}`; raw strings too. */
function strings(code: string): string[] {
  return [...code.matchAll(/"""([\s\S]*?)"""|"((?:[^"\\\n]|\\.)*)"/g)].map((m) => template(m[1] ?? m[2] ?? "")).filter((s) => s.trim().length >= 2);
}

function template(s: string): string {
  return s
    .replace(/\$\{([^}]*)\}/g, (_, e: string) => `{${e.trim()}}`)
    .replace(/\$(\w+)/g, "{$1}")
    .replace(/\\(.)/g, "$1");
}

/** The index of the `)` closing the `(` at `open`, skipping strings. */
function matchParen(text: string, open: number): number {
  return matchPair(text, open, "(", ")");
}

/** The index of the `}` closing the `{` at `open`, skipping strings (and the braces of their templates). */
function matchBrace(text: string, open: number): number {
  return matchPair(text, open, "{", "}");
}

function matchPair(text: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      i = end < 0 ? text.length : end + 2;
    } else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"' && text[i] !== "\n"; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === "$" && text[i + 1] === "{") i = matchBrace(text, i + 1);
      }
    } else if (c === "'" && text.indexOf("'", i + 1) - i <= 3) {
      i = text.indexOf("'", i + 1);
    } else if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i;
  }
  return text.length;
}

/** Comments blanked to spaces (lengths kept), so braces and quotes in them don't count. */
function blankComments(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => (c.startsWith('"') ? c : c.replace(/[^\n]/g, " ")));
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

async function walk(dir: string, keep: (file: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) out.push(...(await walk(path, keep)));
    } else if (keep(path)) out.push(path);
  }
  return out;
}

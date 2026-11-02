import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import {
  blankComments,
  lineAt,
  matchBrace,
  matchParen,
  type PhoneApp,
  type PhoneCall,
  type PhoneScreen,
  reachableCalls,
  walk,
} from "./phone-code.ts";
import { type UiFacts, unique } from "./source.ts";

export type AndroidCall = PhoneCall;
export type AndroidScreen = PhoneScreen;
export type AndroidApp = PhoneApp;


const SKIP_DIRS = new Set(["build", ".gradle", ".kotlin", ".idea", ".git", ".windtunnel", "node_modules"]);
const BUTTONS = /\b(?:Button|TextButton|OutlinedButton|ElevatedButton|FilledTonalButton|IconButton|FloatingActionButton|ExtendedFloatingActionButton)\s*\(/g;

/** An Android app's screens and server calls under `root`; undefined when there's no AndroidManifest.xml. */
export async function findAndroidApp(root: string): Promise<AndroidApp | undefined> {
  const manifests = await walk(root, (f) => f.endsWith("AndroidManifest.xml"), SKIP_DIRS);
  if (manifests.length === 0) return undefined;
  const gradle = (await Promise.all((await walk(root, (f) => /build\.gradle(\.kts)?$/.test(f), SKIP_DIRS)).map((f) => readFile(f, "utf8")))).join("\n");
  const compose = /compose\s*=\s*true|androidx\.compose/.test(gradle);

  const files = await Promise.all(
    (await walk(root, (f) => f.endsWith(".kt"), SKIP_DIRS)).sort().map(async (file) => ({ file, text: blankComments(await readFile(file, "utf8")) })),
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

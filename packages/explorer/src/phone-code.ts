import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type UiFacts, unique } from "./source.ts";

// What the Map reads in a phone app's code, Kotlin or Swift: its screens and the server calls
// they lead to. The scanning here knows strings, comments and brackets, not a language.

/** A call the phone app makes to its server, found in its code. */
export interface PhoneCall {
  method: string;
  /** As written, with template parts as `{name}`: `/api/orders/{orderId}`. */
  path: string;
  file: string;
  line: number;
  /** The function it's in: `pay`. */
  fn?: string;
}

export interface PhoneScreen {
  name: string;
  file: string;
  line: number;
  /** What it shows, and the server calls its actions lead to (through the view model, two calls deep). */
  ui: UiFacts;
}

export interface PhoneApp {
  framework: string;
  screens: PhoneScreen[];
  calls: PhoneCall[];
}


/** Server calls in functions the screen calls, and the functions those call: a screen's actions as far as its view model's API. */
export function reachableCalls(body: string, functions: Map<string, { body: string }[]>, calls: PhoneCall[]): { method: string; url: string }[] {
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
export function calledNames(body: string): Set<string> {
  return new Set([...body.matchAll(/::(\w+)\b/g), ...body.matchAll(/(\w+)\s*\(/g)].map((m) => m[1]!));
}

/** The index of the `)` closing the `(` at `open`, skipping strings. */
export function matchParen(text: string, open: number): number {
  return matchPair(text, open, "(", ")");
}

/** The index of the `}` closing the `{` at `open`, skipping strings (and the braces of their templates). */
export function matchBrace(text: string, open: number): number {
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
export function blankComments(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => (c.startsWith('"') ? c : c.replace(/[^\n]/g, " ")));
}

export function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export async function walk(dir: string, keep: (file: string) => boolean, skip: Set<string>): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name) && !e.name.startsWith(".")) out.push(...(await walk(path, keep, skip)));
    } else if (keep(path)) out.push(path);
  }
  return out;
}

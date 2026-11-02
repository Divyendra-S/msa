import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { blankComments, lineAt, matchBrace, matchParen, type PhoneApp, type PhoneCall, reachableCalls, walk } from "./phone-code.ts";
import { type UiFacts, unique } from "./source.ts";

const SKIP_DIRS = new Set(["build", "DerivedData", ".build", "Pods", ".git", ".windtunnel", "node_modules"]);
const METHODS = "GET|POST|PUT|PATCH|DELETE";

/**
 * An iOS app's screens and server calls under `root`; undefined without an Xcode project or a
 * Swift package. Screens are SwiftUI views named `…Screen` (or `…View` when none is).
 */
export async function findIosApp(root: string): Promise<PhoneApp | undefined> {
  const projects = await walk(root, (f) => f.endsWith(".xcodeproj/project.pbxproj") || f.endsWith("Package.swift"), SKIP_DIRS);
  if (projects.length === 0) return undefined;
  const files = await Promise.all(
    (await walk(root, (f) => f.endsWith(".swift") && !f.endsWith("Package.swift"), SKIP_DIRS))
      .sort()
      .map(async (file) => ({ file, text: blankComments(await readFile(file, "utf8")) })),
  );
  if (files.length === 0) return undefined;
  const swiftUI = files.some((f) => /^import SwiftUI\b/m.test(f.text));

  const functions = new Map<string, { body: string }[]>();
  const calls: PhoneCall[] = [];
  const views: { name: string; file: string; line: number; body: string }[] = [];
  for (const { file, text } of files) {
    for (const fn of swiftFunctions(text)) functions.set(fn.name, [...(functions.get(fn.name) ?? []), { body: fn.body }]);
    for (const m of text.matchAll(/\bstruct\s+(\w+)\s*:\s*([^{]*)\{/g)) {
      if (!/\bView\b/.test(m[2]!)) continue;
      const open = m.index + m[0].length - 1;
      views.push({ name: m[1]!, file: relative(root, file), line: lineAt(text, m.index), body: text.slice(open, matchBrace(text, open) + 1) });
    }
    for (const call of serverCalls(text)) calls.push({ ...call, file: relative(root, file) });
  }
  const screens = views.some((v) => v.name.endsWith("Screen")) ? views.filter((v) => v.name.endsWith("Screen")) : views.filter((v) => v.name.endsWith("View"));

  return {
    framework: swiftUI ? "iOS (SwiftUI)" : "iOS",
    calls,
    screens: screens.map((s) => ({ name: s.name, file: s.file, line: s.line, ui: { ...screenUi(s.body), requests: reachableCalls(s.body, functions, calls) } })),
  };
}

/** `call("POST", "/api/orders", …)` style helpers, in the function they're in. */
function serverCalls(text: string): Omit<PhoneCall, "file">[] {
  const FUNC = /\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  return [...text.matchAll(new RegExp(`"(${METHODS})"\\s*,\\s*"(\\/(?:[^"\\\\]|\\\\.)*)"`, "g"))].map((m) => {
    const fn = [...text.slice(0, m.index).matchAll(FUNC)].at(-1)?.[1];
    return { method: m[1]!, path: template(m[2]!), line: lineAt(text, m.index), ...(fn ? { fn } : {}) };
  });
}

/** Buttons (their titles and accessibility labels), field placeholders and texts a view shows. */
function screenUi(body: string): Omit<UiFacts, "requests"> {
  const buttons: string[] = [];
  for (const m of body.matchAll(/\bButton\s*\(/g)) {
    const close = matchParen(body, m.index + m[0].length - 1);
    for (const s of swiftStrings(body.slice(m.index + m[0].length, close))) buttons.push(s);
  }
  const firstString = (re: RegExp) => [...body.matchAll(re)].flatMap((m) => swiftStrings(body.slice(m.index + m[0].length)).slice(0, 1));
  buttons.push(...firstString(/\.accessibilityLabel\(\s*(?=")/g));
  const fields = firstString(/\b(?:TextField|SecureField)\s*\(\s*(?=")/g);
  const texts = firstString(/\bText\s*\(\s*(?=")/g).filter((s) => !buttons.includes(s) && !fields.includes(s));
  return { buttons: unique(buttons), fields: unique(fields), texts: unique(texts), links: [], redirects: [] };
}

interface SwiftFn {
  name: string;
  body: string;
}

/** Functions with a body (`{` on the line that ends their signature). */
function swiftFunctions(text: string): SwiftFn[] {
  const out: SwiftFn[] = [];
  for (const m of text.matchAll(/\bfunc\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const close = matchParen(text, m.index + m[0].length - 1);
    const head = /^[^{}\n]*\{/.exec(text.slice(close + 1));
    if (!head) continue;
    const open = close + head[0].length;
    out.push({ name: m[1]!, body: text.slice(open, matchBrace(text, open) + 1) });
  }
  return out;
}

/**
 * The string literals in `code`, in order, with interpolations as `{expression}`: an
 * interpolation can hold parentheses and strings of its own (`"\(n > 0 ? "\(n) left" : "none")"`).
 */
function swiftStrings(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '"') continue;
    const { text, end } = readString(code, i);
    if (text.trim().length >= 2) out.push(text);
    i = end;
  }
  return out;
}

/** The string literal starting at `start` (a quote): its text and the index of its closing quote. */
function readString(code: string, start: number): { text: string; end: number } {
  let text = "";
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "\n") return { text, end: i };
    if (c !== "\\") {
      text += c;
      continue;
    }
    if (code[i + 1] !== "(") {
      text += code[i + 1] ?? "";
      i++;
      continue;
    }
    // An interpolation: to its matching parenthesis, past any strings inside it.
    let depth = 0;
    let j = i + 1;
    for (; j < code.length; j++) {
      if (code[j] === '"') j = readString(code, j).end;
      else if (code[j] === "(") depth++;
      else if (code[j] === ")" && --depth === 0) break;
    }
    text += `{${code.slice(i + 2, j).trim()}}`;
    i = j;
  }
  return { text, end: code.length };
}

function template(s: string): string {
  return swiftStrings(`"${s}"`)[0] ?? s;
}

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type Effect, parseSql, type UiFacts, unique } from "./source.ts";

/** A `#[tauri::command]` function: what a page's `invoke("name", …)` runs. */
export interface TauriCommand {
  name: string;
  /** Relative to the app's root. */
  file: string;
  line: number;
  /** First line of its `///` doc comment. */
  comment?: string;
  /** Async commands run on Tauri's thread pool and can overlap; the rest run on the main thread, one at a time. */
  async: boolean;
  /** SQL in its body and in the functions it calls, in order; what follows `transaction()` is one transaction. */
  effects: Effect[];
  /** Events it emits. */
  emits: string[];
  /** Frontend lines that invoke it, `file:line`. */
  callers: string[];
}

export interface TauriApp {
  /** `Tauri 2.12`, from the app's Cargo.toml. */
  framework: string;
  commands: TauriCommand[];
  /** The frontend's pages: buttons, fields and texts from its HTML and scripts. */
  pages: { path: string; file: string; ui: UiFacts }[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".windtunnel", "target", "gen", "dist", "build", "out"]);
const FRONTEND = /\.(m?jsx?|tsx?|vue|svelte)$/;

/** A Tauri app's commands and frontend under `root`; undefined when it isn't one (no tauri.conf.json). */
export async function findTauriApp(root: string): Promise<TauriApp | undefined> {
  const confDir = (await exists(join(root, "src-tauri", "tauri.conf.json"))) ? join(root, "src-tauri") : (await exists(join(root, "tauri.conf.json"))) ? root : undefined;
  if (!confDir) return undefined;
  const cargo = await readFile(join(confDir, "Cargo.toml"), "utf8").catch(() => "");
  const version = /^\s*tauri\s*=\s*(?:\{[^}]*version\s*=\s*)?"[^\d]*([\d.]+)/m.exec(cargo)?.[1];

  const rustFiles = await walk(confDir, (f) => f.endsWith(".rs"));
  const sources = await Promise.all(rustFiles.map(async (file) => ({ file, text: stripComments(await readFile(file, "utf8")), raw: await readFile(file, "utf8") })));
  const helpers = new Map<string, { file: string; body: string }>();
  const found: { name: string; file: string; line: number; comment?: string; async: boolean; body: string }[] = [];
  for (const { file, text, raw } of sources) {
    for (const fn of functions(text)) {
      if (fn.command) found.push({ name: fn.name, file, line: lineAt(text, fn.start), comment: docComment(raw, fn.start), async: fn.async, body: fn.body });
      else if (!helpers.has(fn.name)) helpers.set(fn.name, { file, body: fn.body });
    }
  }

  const frontendFiles = (await walk(root, (f) => FRONTEND.test(f) || f.endsWith(".html"), new Set([...SKIP_DIRS, "src-tauri"]))).sort();
  const frontend = await Promise.all(frontendFiles.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
  const callers = new Map<string, string[]>();
  for (const { file, text } of frontend) {
    for (const m of text.matchAll(/\binvoke\s*(?:<[^>()]*>)?\s*\(\s*["'`]([\w:|-]+)["'`]/g)) {
      const at = `${relative(root, file)}:${lineAt(text, m.index)}`;
      callers.set(m[1]!, [...(callers.get(m[1]!) ?? []), at]);
    }
  }

  const commands = found.map((c): TauriCommand => ({
    name: c.name,
    file: relative(root, c.file),
    line: c.line,
    ...(c.comment ? { comment: c.comment } : {}),
    async: c.async,
    effects: effectsOf(c.body, helpers, root),
    emits: unique([...c.body.matchAll(/\.emit(?:_to|_filter)?\(\s*(?:[^,()"]+,\s*)?"([^"]+)"/g)].map((m) => m[1]!)),
    callers: callers.get(c.name) ?? [],
  }));
  return { framework: `Tauri${version ? ` ${version}` : ""}`, commands, pages: frontendPages(root, frontend) };
}

interface RustFn {
  name: string;
  command: boolean;
  async: boolean;
  start: number;
  body: string;
}

/** Top-level and impl functions with their bodies (comments already blanked out). */
function functions(text: string): RustFn[] {
  const out: RustFn[] = [];
  const header = /((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s+(\w+)/g;
  for (const m of text.matchAll(header)) {
    const open = bodyStart(text, m.index + m[0].length);
    if (open === undefined) continue;
    const close = matchBrace(text, open);
    out.push({ name: m[3]!, command: /#\[\s*tauri::command\b/.test(m[1]!), async: !!m[2], start: m.index + m[1]!.length, body: text.slice(open + 1, close) });
  }
  return out;
}

/** The `{` that opens a function's body: the first one outside its signature's parentheses and angle brackets; none for a declaration ending in `;`. */
function bodyStart(text: string, from: number): number | undefined {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && c === "{") return i;
    else if (depth === 0 && c === ";") return undefined;
  }
  return undefined;
}

/** The index of the `}` closing the `{` at `open`, skipping strings and char literals. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const raw = /^r(#*)"/.exec(text.slice(i, i + 12));
    if (raw && !/\w/.test(text[i - 1] ?? "")) {
      const end = text.indexOf(`"${raw[1]}`, i + raw[0].length);
      i = end < 0 ? text.length : end + raw[1]!.length;
    } else if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "'" && (text[i + 2] === "'" || (text[i + 1] === "\\" && text.indexOf("'", i + 2) - i <= 10))) {
      i = text.indexOf("'", i + 2);
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return text.length;
}

/** Comments blanked to spaces (lengths kept), so braces and quotes in them don't count. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, " "));
}

/** The first line of the `///` comment right above `at` (attributes in between are fine). */
function docComment(raw: string, at: number): string | undefined {
  const above = raw.slice(0, at).split("\n");
  const lines: string[] = [];
  for (let i = above.length - 1; i >= 0; i--) {
    const line = above[i]!.trim();
    if (line === "" && lines.length === 0 && i === above.length - 1) continue;
    if (line.startsWith("#[")) continue;
    if (!line.startsWith("///")) break;
    lines.unshift(line.replace(/^\/\/\/\s?/, ""));
  }
  return lines.find((l) => l.trim())?.trim();
}

/** SQL string literals and calls to known helpers, in source order; after `transaction()`, inside a tx. */
function effectsOf(body: string, helpers: Map<string, { file: string; body: string }>, root: string, depth = 0): Effect[] {
  const items: { at: number; effect: Effect }[] = [];
  for (const m of body.matchAll(/r(#*)"([\s\S]*?)"\1|"((?:[^"\\]|\\.)*)"/g)) {
    const sql = parseSql((m[2] ?? m[3] ?? "").replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    if (sql) items.push({ at: m.index, effect: sql });
  }
  if (depth < 2) {
    for (const m of body.matchAll(/(?<![\w.:])(\w+)\s*\(/g)) {
      const helper = helpers.get(m[1]!);
      if (!helper) continue;
      const effects = effectsOf(helper.body, helpers, root, depth + 1);
      if (effects.length) items.push({ at: m.index, effect: { kind: "call", name: m[1]!, file: relative(root, helper.file), auth: false, keyArg: false, effects } });
    }
  }
  items.sort((a, b) => a.at - b.at);
  const tx = /\.transaction\s*\(/.exec(body)?.index;
  if (tx === undefined) return items.map((i) => i.effect);
  return [...items.filter((i) => i.at < tx).map((i) => i.effect), { kind: "tx", effects: items.filter((i) => i.at > tx).map((i) => i.effect) }];
}

/** Buttons, fields and texts from the frontend's HTML and scripts; commands it invokes as its requests. */
function frontendPages(root: string, files: { file: string; text: string }[]): TauriApp["pages"] {
  const html = files.find((f) => f.file.endsWith("index.html")) ?? files.find((f) => f.file.endsWith(".html"));
  if (!html) return [];
  const all = files.map((f) => f.text).join("\n");
  const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const buttons = [...all.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => plain(m[1]!)).filter(Boolean);
  const fields = [
    ...[...all.matchAll(/<(?:input|textarea|select)\b[^>]*\baria-label="([^"]+)"/g)].map((m) => m[1]!),
    ...[...all.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => plain(m[1]!)),
  ];
  const texts = [
    ...[...all.matchAll(/<(?:p|h[1-3])\b[^>]*>([^<]+)<\/(?:p|h[1-3])>/g)].map((m) => plain(m[1]!)),
    // Status lines a script sets: show("Saved"), status.textContent = "…".
    ...[...all.matchAll(/\b(?:show|setStatus|notify|toast)\(\s*["'`]([^"'`$]{2,60})["'`]\s*\)/g)].map((m) => m[1]!),
    ...[...all.matchAll(/\.textContent\s*=\s*["'`]([^"'`$]{2,60})["'`]/g)].map((m) => m[1]!),
  ];
  const requests = unique([...all.matchAll(/\binvoke\s*(?:<[^>()]*>)?\s*\(\s*["'`]([\w:|-]+)["'`]/g)].map((m) => m[1]!)).map((url) => ({ method: "INVOKE", url }));
  return [{ path: "/", file: relative(root, html.file), ui: { buttons: unique(buttons), texts: unique(texts), links: [], fields: unique(fields), requests, redirects: [] } }];
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

async function walk(dir: string, keep: (file: string) => boolean, skip = SKIP_DIRS): Promise<string[]> {
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

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    () => false,
  );
}

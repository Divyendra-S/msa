import { readFile, writeFile } from "node:fs/promises";
import { CONTROL_ROLES, describeElement, locatorFor, type PageSnapshot, type SnapshotElement } from "@windtunnel/core";
import ts from "typescript";

// ---- Playwright locator descriptions: getByRole('button', { name: 'Pay now' }) ----

export type LocatorValue =
  | { type: "string"; value: string }
  | { type: "regex"; source: string; flags: string }
  | { type: "number"; value: number }
  | { type: "bool"; value: boolean }
  | { type: "object"; props: Record<string, LocatorValue> }
  | { type: "chain"; calls: LocatorCall[] };

export interface LocatorCall {
  method: string;
  args: LocatorValue[];
}

export interface ParsedLocator {
  calls: LocatorCall[];
  /** The call that picks the element: the last getBy…/locator, before first()/nth()/filter(). */
  target?: LocatorCall;
  /** Uses or()/and(): one of several things, which a single replacement can't stand for. */
  composite: boolean;
}

const PICKERS = /^(getBy(Role|Text|Label|Placeholder|TestId|Title|AltText)|locator)$/;

/** Parses the locator text Playwright prints in errors ("waiting for …"). Undefined when it can't. */
export function parseLocator(text: string): ParsedLocator | undefined {
  let i = 0;
  const s = text.trim();
  const ws = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  const expect = (c: string) => {
    ws();
    if (s[i] !== c) throw new Error(`expected ${c} at ${i}`);
    i++;
  };
  const ident = (): string => {
    ws();
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) throw new Error(`expected a name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const str = (): string => {
    const quote = s[i++]!;
    let out = "";
    while (i < s.length && s[i] !== quote) {
      if (s[i] === "\\") {
        const next = s[i + 1]!;
        out += next === "n" ? "\n" : next;
        i += 2;
      } else out += s[i++];
    }
    i++;
    return out;
  };
  const regex = (): LocatorValue => {
    i++;
    let source = "";
    let inClass = false;
    while (i < s.length && (s[i] !== "/" || inClass)) {
      if (s[i] === "\\") {
        source += s[i]! + s[i + 1]!;
        i += 2;
        continue;
      }
      if (s[i] === "[") inClass = true;
      if (s[i] === "]") inClass = false;
      source += s[i++];
    }
    i++;
    const flags = /^[a-z]*/.exec(s.slice(i))![0];
    i += flags.length;
    return { type: "regex", source, flags };
  };
  const value = (): LocatorValue => {
    ws();
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") return { type: "string", value: str() };
    if (c === "/") return regex();
    if (c === "{") {
      i++;
      const props: Record<string, LocatorValue> = {};
      ws();
      while (s[i] !== "}") {
        const key = ident();
        expect(":");
        props[key] = value();
        ws();
        if (s[i] === ",") i++;
        ws();
      }
      i++;
      return { type: "object", props };
    }
    const num = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return { type: "number", value: Number(num[0]) };
    }
    if (s.startsWith("true", i) && !/[\w$]/.test(s[i + 4] ?? "")) return (i += 4), { type: "bool", value: true };
    if (s.startsWith("false", i) && !/[\w$]/.test(s[i + 5] ?? "")) return (i += 5), { type: "bool", value: false };
    return { type: "chain", calls: chain() };
  };
  const chain = (): LocatorCall[] => {
    const calls: LocatorCall[] = [];
    for (;;) {
      const method = ident();
      expect("(");
      const args: LocatorValue[] = [];
      ws();
      while (s[i] !== ")") {
        args.push(value());
        ws();
        if (s[i] === ",") i++;
        ws();
      }
      i++;
      calls.push({ method, args });
      ws();
      if (s[i] !== ".") break;
      i++;
    }
    return calls;
  };
  try {
    const calls = chain();
    ws();
    if (i < s.length) return undefined;
    const composite = calls.some((c) => c.method === "or" || c.method === "and");
    const target = [...calls].reverse().find((c) => PICKERS.test(c.method));
    return { calls, target, composite };
  } catch {
    return undefined;
  }
}

/** The values a picker call looks for: getByRole's role and name, or getByText's text. */
export function pickerTerms(call: LocatorCall): { role?: string; text?: LocatorValue; exact?: boolean } {
  const [first, second] = call.args;
  if (call.method === "getByRole") {
    const options = second?.type === "object" ? second.props : {};
    const exact = options.exact?.type === "bool" ? options.exact.value : undefined;
    return { role: first?.type === "string" ? first.value : undefined, text: options.name, ...(exact !== undefined ? { exact } : {}) };
  }
  const options = second?.type === "object" ? second.props : {};
  const exact = options.exact?.type === "bool" ? options.exact.value : undefined;
  return { text: first, ...(exact !== undefined ? { exact } : {}) };
}

// ---- Finding the call in a flow's source ----

export interface SourceMatch {
  file: string;
  line: number;
  /** Offsets of `getByRole(…)` (the method name to the closing parenthesis). */
  start: number;
  end: number;
  text: string;
  /** Built from variables or template strings, so the literal can't simply be replaced. */
  dynamic: boolean;
  quote: '"' | "'";
}

/** Calls in `files` that build the picker `call` (same method and arguments). */
export async function findInSource(files: string[], call: LocatorCall): Promise<SourceMatch[]> {
  const out: SourceMatch[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === call.method) {
        const match = compareArgs(node.arguments, call.args);
        if (match !== "different") {
          const start = node.expression.name.getStart(sf);
          const firstLiteral = node.arguments.find((a) => ts.isStringLiteral(a));
          out.push({
            file,
            line: sf.getLineAndCharacterOfPosition(start).line + 1,
            start,
            end: node.end,
            text: text.slice(start, node.end),
            dynamic: match === "dynamic",
            quote: firstLiteral && text[firstLiteral.getStart(sf)] === "'" ? "'" : '"',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** same: every argument is a literal equal to Playwright's · dynamic: the literal parts agree, others are expressions. */
function compareArgs(source: ts.NodeArray<ts.Expression>, wanted: LocatorValue[]): "same" | "dynamic" | "different" {
  let dynamic = false;
  const cmp = (node: ts.Expression | undefined, value: LocatorValue | undefined): boolean => {
    if (!node || !value) return !node && !value;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return value.type === "string" && node.text === value.value;
    if (ts.isRegularExpressionLiteral(node)) return value.type === "regex" && node.text === `/${value.source}/${value.flags}`;
    if (ts.isNumericLiteral(node)) return value.type === "number" && Number(node.text) === value.value;
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      return value.type === "bool" && value.value === (node.kind === ts.SyntaxKind.TrueKeyword);
    }
    if (ts.isObjectLiteralExpression(node) && value.type === "object") {
      const keys = new Set(Object.keys(value.props));
      for (const p of node.properties) {
        if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
          dynamic = true;
          continue;
        }
        const key = p.name.text;
        if (!keys.has(key)) return false;
        keys.delete(key);
        if (!cmp(p.initializer, value.props[key])) return false;
      }
      return keys.size === 0 || dynamic;
    }
    // A variable, a template with ${…}, a call: can't tell from the source alone.
    dynamic = true;
    return true;
  };
  if (source.length !== wanted.length) return "different";
  for (let k = 0; k < source.length; k++) if (!cmp(source[k], wanted[k])) return "different";
  return dynamic ? "dynamic" : "same";
}

/** Replaces each match with `code` (a picker call such as `getByRole("button", { name: "Pay" })`). */
export async function replaceInSource(matches: SourceMatch[], code: string): Promise<{ file: string; before: string }[]> {
  const byFile = new Map<string, SourceMatch[]>();
  for (const m of matches) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  const saved: { file: string; before: string }[] = [];
  for (const [file, list] of byFile) {
    const before = await readFile(file, "utf8");
    let text = before;
    for (const m of [...list].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, m.start) + (m.quote === "'" ? singleQuoted(code) : code) + text.slice(m.end);
    }
    await writeFile(file, text);
    saved.push({ file, before });
  }
  return saved;
}

export async function restoreSource(saved: { file: string; before: string }[]): Promise<void> {
  for (const s of saved) await writeFile(s.file, s.before);
}

function singleQuoted(code: string): string {
  return code.replace(/"((?:[^"\\]|\\.)*)"/g, (_m, inner: string) => `'${inner.replace(/\\"/g, '"').replace(/'/g, "\\'")}'`);
}

// ---- Candidates on the page ----

export interface Candidate {
  element: SnapshotElement;
  /** 0–1: how close its role and name are to what the flow asked for. */
  score: number;
  /** A picker call for the flow, without the `page.` receiver: `getByRole("button", { name: "Pay" })`. */
  code: string;
  /** With the receiver and any first()/nth(). */
  full: string;
}

const DESTRUCTIVE = /\b(log ?out|sign ?out|log ?off|delete|remove|cancel)\b/i;

/** Roles a renamed control may have moved to. */
const RELATED: Record<string, string[]> = {
  button: ["link", "menuitem", "tab"],
  link: ["button", "menuitem", "tab"],
  textbox: ["searchbox", "combobox", "spinbutton"],
  searchbox: ["textbox", "combobox"],
  combobox: ["textbox", "listbox"],
  checkbox: ["switch", "radio"],
  switch: ["checkbox"],
};

/** Elements on the page that could be what the flow's locator meant, best first. */
export function rankCandidates(call: LocatorCall, snapshot: PageSnapshot, action?: string): Candidate[] {
  const terms = pickerTerms(call);
  const wanted = terms.text;
  const all = snapshot.elements;
  const label = wanted?.type === "string" ? wanted.value : wanted?.type === "regex" ? wanted.source.replace(/\\(.)/g, "$1") : "";
  const scored: Candidate[] = [];
  const destructive = DESTRUCTIVE.test(label);
  for (const e of all) {
    // Never suggest logging out or deleting in place of something else.
    if (!destructive && DESTRUCTIVE.test(e.name)) continue;
    let score: number;
    // A control of the same role stays a candidate however it is named now (scored low, so rules alone won't pick it).
    let floor = 0;
    if (call.method === "getByRole") {
      const related = e.role === terms.role ? 1 : RELATED[terms.role ?? ""]?.includes(e.role) ? 0.85 : 0;
      if (!related) continue;
      score = (label ? similarity(label, e.name) : 0.5) * related;
      if (related === 1) floor = 0.1;
    } else if (call.method === "getByText") {
      score = similarity(label, e.name);
      if (["heading", "alert", "status", "paragraph", "dialog"].includes(e.role)) floor = 0.1;
    } else if (call.method === "getByLabel" || call.method === "getByPlaceholder") {
      if (!CONTROL_ROLES.has(e.role)) continue;
      score = Math.max(similarity(label, e.name), e.placeholder ? similarity(label, e.placeholder) : 0);
      if (["textbox", "searchbox", "combobox", "spinbutton"].includes(e.role)) floor = 0.1;
    } else {
      // getByTestId, CSS: nothing on the page to compare with but the kind of action.
      const clicks = action === "click" || action === "dblclick" || action === "tap";
      if (!(clicks ? ["button", "link"].includes(e.role) : ["textbox", "searchbox", "combobox"].includes(e.role))) continue;
      score = 0.3;
    }
    if (score < 0.3) {
      if (!floor) continue;
      score = Math.max(score, floor);
    }
    const full = sameStyle(call.method, e, all) ?? locatorFor(e, all);
    scored.push({ element: e, score, full, code: full.replace(/^page\./, "") });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** The flow's own kind of locator when it still fits: getByLabel stays getByLabel, getByText stays getByText. */
function sameStyle(method: string, e: SnapshotElement, all: SnapshotElement[]): string | undefined {
  const q = JSON.stringify;
  const exact = (names: string[], name: string) => names.some((n) => n !== name && n.toLowerCase().includes(name.toLowerCase()));
  if (method === "getByLabel" && e.name && CONTROL_ROLES.has(e.role)) {
    return `page.getByLabel(${q(e.name)}${exact(all.filter((x) => CONTROL_ROLES.has(x.role)).map((x) => x.name), e.name) ? ", { exact: true }" : ""})`;
  }
  if (method === "getByPlaceholder" && e.placeholder) return `page.getByPlaceholder(${q(e.placeholder)})`;
  if (method === "getByText" && e.name && !CONTROL_ROLES.has(e.role)) {
    const texts = all.filter((x) => !CONTROL_ROLES.has(x.role)).map((x) => x.name);
    return `page.getByText(${q(e.name)}${exact(texts, e.name) ? ", { exact: true }" : ""})`;
  }
  return undefined;
}

/** 1 for the same words; partial credit for shared words, containment and shared letter pairs. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const shared = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = shared / new Set([...ta, ...tb]).size;
  const contains = na.includes(nb) || nb.includes(na) ? 0.6 + 0.3 * (Math.min(na.length, nb.length) / Math.max(na.length, nb.length)) : 0;
  return Math.max(jaccard, contains, dice(na, nb) * 0.9);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function dice(a: string, b: string): number {
  const pairs = (s: string) => {
    const out = new Map<string, number>();
    for (let k = 0; k < s.length - 1; k++) out.set(s.slice(k, k + 2), (out.get(s.slice(k, k + 2)) ?? 0) + 1);
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  let both = 0;
  for (const [p, n] of pa) both += Math.min(n, pb.get(p) ?? 0);
  const total = a.length - 1 + b.length - 1;
  return total > 0 ? (2 * both) / total : 0;
}

/** Actions that do something; a wait checks what the app shows, and is never healed by rules alone. */
export const ACTS = new Set(["click", "dblclick", "tap", "fill", "press", "pressSequentially", "type", "check", "uncheck", "setChecked", "selectOption", "hover", "focus", "setInputFiles", "clear", "dragTo"]);

/**
 * Plain code's pick among the candidates: confident only for an action whose best candidate
 * is clearly ahead, or for an exact-name twin of an ambiguous match.
 */
export function rulesPick(candidates: Candidate[], options: { action: string; matched?: number; call: LocatorCall }): { index: number; confidence: number } | undefined {
  const [best, second] = candidates;
  if (!best) return undefined;
  if (options.matched) {
    // Several elements matched: if exactly one has the name itself (not just containing it), exact: true picks it.
    const name = pickerTerms(options.call).text;
    const exact = name?.type === "string" ? candidates.filter((c) => c.element.name === name.value) : [];
    return exact.length === 1 ? { index: candidates.indexOf(exact[0]!), confidence: 0.9 } : { index: 0, confidence: 0.3 };
  }
  const lead = best.score - (second?.score ?? 0);
  if (!ACTS.has(options.action)) return { index: 0, confidence: best.score === 1 ? 0.85 : Math.min(0.6, best.score * 0.6) };
  const confidence = best.score >= 0.75 && lead >= 0.2 ? 0.9 : best.score >= 0.6 && lead >= 0.3 ? 0.8 : best.score * 0.6;
  // The only control of that role left on the page: worth a try, as a run of the whole flow checks it before it is kept.
  const only = candidates.length === 1 && best.element.role === pickerTerms(options.call).role;
  return { index: 0, confidence: only ? Math.max(confidence, 0.8) : confidence };
}

/** For a strict-mode failure with an exact twin: the same call with `exact: true`. */
export function withExact(call: LocatorCall): string | undefined {
  const t = pickerTerms(call);
  if (t.text?.type !== "string") return undefined;
  const q = JSON.stringify;
  if (call.method === "getByRole" && t.role) return `getByRole(${q(t.role)}, { name: ${q(t.text.value)}, exact: true })`;
  if (call.method === "getByText" || call.method === "getByLabel") return `${call.method}(${q(t.text.value)}, { exact: true })`;
  return undefined;
}

export function candidateLabel(c: Candidate): string {
  return `${describeElement(c.element)}${c.element.near ? ` (under "${c.element.near.slice(0, 40)}")` : ""} → ${c.full}`;
}

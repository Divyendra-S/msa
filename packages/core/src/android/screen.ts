import type { PageSnapshot, SnapshotElement } from "../runner/snapshot.ts";

/** One element of the screen, from UiAutomator's view of it (Appium's page source). */
export interface ScreenNode {
  className: string;
  text: string;
  /** The accessibility label (`contentDescription`). */
  desc: string;
  hint: string;
  resourceId: string;
  clickable: boolean;
  enabled: boolean;
  password: boolean;
  /** Announced when it changes: Compose's `liveRegion`, Android's `accessibilityLiveRegion` (an alert or status). */
  live: boolean;
  /** Left, top, right, bottom in screen pixels. */
  bounds: [number, number, number, number];
  parent?: ScreenNode;
  children: ScreenNode[];
}

export interface Screen {
  width: number;
  height: number;
  nodes: ScreenNode[];
}

const TAG = /<(\/?)([\w.$-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g;
const ATTR = /([\w:.-]+)="([^"]*)"/g;

/** Parses Appium's UiAutomator2 page source. Nodes are in document order, which is reading order. */
export function parseScreen(xml: string): Screen {
  const nodes: ScreenNode[] = [];
  const stack: ScreenNode[] = [];
  let width = 0;
  let height = 0;
  for (const m of xml.matchAll(TAG)) {
    const [, closing, name, attrText, selfClosing] = m;
    if (name === "?xml") continue;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(ATTR)) attrs[a[1]!] = unescape(a[2]!);
    if (name === "hierarchy") {
      width = Number(attrs.width ?? 0);
      height = Number(attrs.height ?? 0);
      if (!selfClosing) stack.push({ className: "hierarchy" } as ScreenNode);
      continue;
    }
    if (attrs.displayed === "false") {
      if (!selfClosing) stack.push({ className: "hidden", children: [] } as unknown as ScreenNode);
      continue;
    }
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds ?? "");
    const parent = stack.at(-1);
    const node: ScreenNode = {
      className: attrs.class ?? name!,
      text: (attrs.text ?? "").trim(),
      desc: (attrs["content-desc"] ?? "").trim(),
      hint: (attrs.hint ?? "").trim(),
      resourceId: attrs["resource-id"] ?? "",
      clickable: attrs.clickable === "true",
      enabled: attrs.enabled !== "false",
      password: attrs.password === "true",
      live: attrs["live-region"] !== undefined && attrs["live-region"] !== "0",
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : [0, 0, 0, 0],
      parent: parent && parent.className !== "hierarchy" && parent.className !== "hidden" ? parent : undefined,
      children: [],
    };
    node.parent?.children.push(node);
    nodes.push(node);
    if (!selfClosing) stack.push(node);
  }
  return { width, height, nodes };
}

function unescape(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Whether a node is on screen at all (Compose keeps scrolled-away nodes with empty bounds). */
export function onScreen(screen: Screen, node: ScreenNode): boolean {
  const [l, t, r, b] = node.bounds;
  return r > l && b > t && r > 0 && b > 0 && (screen.width === 0 || l < screen.width) && (screen.height === 0 || t < screen.height);
}

/** What the user reads on a node: its text, else its accessibility label. */
function readable(node: ScreenNode): string {
  return node.text || node.desc;
}

/** Every text on screen, top to bottom; a field shows its label, never a password's value. */
export function screenTexts(screen: Screen): string[] {
  const out: string[] = [];
  for (const node of screen.nodes) {
    if (!onScreen(screen, node)) continue;
    if (node.password) continue;
    if (node.text) out.push(node.text);
    if (node.desc && node.desc !== node.text) out.push(node.desc);
  }
  return out;
}

export function matchesText(candidate: string, text: string | RegExp): boolean {
  if (typeof text !== "string") return text.test(candidate);
  return normalize(candidate).toLowerCase().includes(normalize(text).toLowerCase());
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function center(node: ScreenNode): { x: number; y: number } {
  const [l, t, r, b] = node.bounds;
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

export type Found<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * The control a tap on `label` hits: a clickable node whose text or accessibility label is
 * `label` (exactly, ignoring case and spacing), or which holds such a text (Compose puts a
 * button's text in a child). Like a user, it ignores matching text that isn't a control.
 */
export function findControl(screen: Screen, label: string): Found<{ node: ScreenNode; x: number; y: number }> {
  const targets = new Set<ScreenNode>();
  for (const node of screen.nodes) {
    if (!onScreen(screen, node) || !sameLabel(node, label)) continue;
    let target: ScreenNode | undefined = node;
    while (target && !target.clickable) target = target.parent;
    if (target) targets.add(target);
  }
  if (targets.size === 0) return { ok: false, reason: `nothing on screen to tap is labelled "${label}"` };
  if (targets.size > 1) return { ok: false, reason: `${targets.size} controls are labelled "${label}": give each its own accessibility label` };
  const node = [...targets][0]!;
  if (!node.enabled) return { ok: false, reason: `"${label}" is disabled` };
  return { ok: true, value: { node, ...center(node) } };
}

function sameLabel(node: ScreenNode, label: string): boolean {
  const want = normalize(label).toLowerCase();
  return [node.text, node.desc].some((v) => v !== "" && normalize(v).toLowerCase() === want);
}

/**
 * The text field labelled `label`: by its accessibility label, hint or id, or by the label
 * Compose draws inside it. `index` counts text fields in reading order, for finding it again.
 */
export function findField(screen: Screen, label: string): Found<{ node: ScreenNode; index: number }> {
  const fields = screen.nodes.filter((n) => n.className === "android.widget.EditText");
  const want = normalize(label).toLowerCase();
  const matches = fields.filter((field) => {
    if (!onScreen(screen, field)) return false;
    const own = [field.desc, field.hint, field.resourceId.split("/").pop() ?? ""];
    if (own.some((v) => v !== "" && normalize(v).toLowerCase() === want)) return true;
    // An empty field without a label of its own shows its placeholder as text.
    if (!field.children.length && normalize(field.text).toLowerCase() === want) return true;
    return descendants(field).some((c) => c.text !== "" && normalize(c.text).toLowerCase() === want);
  });
  if (matches.length === 0) return { ok: false, reason: `no text field labelled "${label}" on screen` };
  if (matches.length > 1) return { ok: false, reason: `${matches.length} text fields are labelled "${label}"` };
  const node = matches[0]!;
  return { ok: true, value: { node, index: fields.indexOf(node) } };
}

function descendants(node: ScreenNode): ScreenNode[] {
  return node.children.flatMap((c) => [c, ...descendants(c)]);
}

/** Texts in live regions: errors and status messages the app announces. */
export function screenAlerts(screen: Screen): string[] {
  const out: string[] = [];
  for (const node of screen.nodes) {
    if (!node.live || !onScreen(screen, node)) continue;
    const text = [node, ...descendants(node)].map(readable).filter(Boolean).join(" ");
    if (text) out.push(text);
  }
  return out;
}

/** The screen as a PageSnapshot, for locator repair: controls by what they're labelled, and the texts. */
export function snapshotScreen(screen: Screen, path: string, title: string): PageSnapshot {
  const elements: SnapshotElement[] = [];
  const named = new Set<ScreenNode>();
  for (const node of screen.nodes) {
    if (!onScreen(screen, node)) continue;
    if (node.className === "android.widget.EditText") {
      const label = node.desc || node.hint || descendants(node).map(readable).find(Boolean) || "";
      elements.push({ role: "textbox", name: label, ...(node.enabled ? {} : { disabled: true }) });
      for (const d of descendants(node)) named.add(d);
    } else if (node.clickable) {
      const name = readable(node) || descendants(node).map(readable).find(Boolean) || "";
      if (!name) continue;
      elements.push({ role: "button", name, ...(node.enabled ? {} : { disabled: true }) });
      for (const d of descendants(node)) if (readable(d) === name) named.add(d);
    } else if (readable(node) && !named.has(node)) {
      elements.push({ role: "text", name: readable(node) });
    }
  }
  return { path, title, elements: elements.slice(0, 400) };
}

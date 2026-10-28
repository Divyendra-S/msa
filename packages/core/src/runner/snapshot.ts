import type { Page } from "playwright";

/** Something on the page a user can act on or read, from Playwright's accessibility snapshot. */
export interface SnapshotElement {
  /** ARIA role, or `text` for plain text. */
  role: string;
  /** Accessible name; for text, the text. */
  name: string;
  url?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  level?: number;
  /** The nearest heading above it, to tell repeated controls apart ("Add to cart" under "Ceramic Mug"). */
  near?: string;
  /** Clickable although its role says otherwise (a div with an onClick). */
  clickable?: boolean;
}

export interface PageSnapshot {
  /** Path and query. */
  path: string;
  title: string;
  elements: SnapshotElement[];
}

/** Roles worth acting on with getByRole. */
export const CONTROL_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
]);
/** Roles whose name is text the user reads. */
const TEXT_ROLES = new Set(["heading", "paragraph", "alert", "status", "cell", "listitem", "caption", "term", "definition", "dialog", "img"]);
const MAX_ELEMENTS = 400;

interface AriaNode {
  role?: string;
  name?: string;
  text?: string;
  url?: string;
  placeholder?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  level?: number;
  cursor?: string;
  children?: (AriaNode | string)[];
}

/** The page's controls and texts in one browser call (about 10 ms). Undefined when the page can't be read. */
export async function snapshotPage(page: Page, timeoutMs = 2_000): Promise<PageSnapshot | undefined> {
  try {
    const tree = (await page.ariaSnapshotJSON({ mode: "ai", timeout: timeoutMs })) as unknown;
    const url = new URL(page.url());
    const title = await page.title().catch(() => "");
    return { path: url.pathname + url.search, title, elements: flattenAria(tree) };
  } catch {
    return undefined;
  }
}

/** Flattens Playwright's aria snapshot JSON into a list, in page order. */
export function flattenAria(tree: unknown): SnapshotElement[] {
  const out: SnapshotElement[] = [];
  let heading: string | undefined;
  const text = (value: string) => {
    const name = value.replace(/\s+/g, " ").trim();
    if (name && out.length < MAX_ELEMENTS) out.push({ role: "text", name, ...(heading ? { near: heading } : {}) });
  };
  const visit = (node: AriaNode | string) => {
    if (typeof node === "string") return text(node);
    const role = node.role ?? "generic";
    const name = (node.name ?? "").replace(/\s+/g, " ").trim();
    if (role === "text") return text(node.text ?? name);
    const clickable = node.cursor === "pointer" && !CONTROL_ROLES.has(role);
    const own = name || (TEXT_ROLES.has(role) || CONTROL_ROLES.has(role) || clickable ? (node.text ?? "").replace(/\s+/g, " ").trim() : "");
    if ((CONTROL_ROLES.has(role) || TEXT_ROLES.has(role) || (clickable && own)) && out.length < MAX_ELEMENTS) {
      out.push({
        role,
        name: own,
        ...(node.url ? { url: node.url } : {}),
        ...(node.placeholder ? { placeholder: node.placeholder } : {}),
        ...(node.disabled ? { disabled: true } : {}),
        ...(node.checked !== undefined ? { checked: node.checked } : {}),
        ...(node.level !== undefined ? { level: node.level } : {}),
        ...(heading && role !== "heading" ? { near: heading } : {}),
        ...(clickable ? { clickable: true } : {}),
      });
    } else if (node.text && !node.children?.length) {
      text(node.text);
    }
    if (role === "heading" && own) heading = own;
    // A control's children repeat its name.
    if (!CONTROL_ROLES.has(role) || role === "listbox" || role === "combobox") for (const child of node.children ?? []) visit(child);
  };
  for (const node of Array.isArray(tree) ? tree : [tree]) visit(node as AriaNode);
  return out;
}

/**
 * Playwright code that finds `element` on this page, the way a flow would write it:
 * `page.getByRole("button", { name: "Pay now" })`, with `exact` or `.nth()` when needed.
 */
export function locatorFor(element: SnapshotElement, all: SnapshotElement[]): string {
  const q = JSON.stringify;
  if (element.role === "text" || (element.clickable && !CONTROL_ROLES.has(element.role) && !TEXT_ROLES.has(element.role))) {
    const same = all.filter((e) => (e.role === "text" || e.clickable) && e.name.toLowerCase().includes(element.name.toLowerCase()));
    const exact = same.some((e) => e.name.toLowerCase() !== element.name.toLowerCase());
    return `page.getByText(${q(element.name)}${exact ? ", { exact: true }" : ""})${nth(element, same.filter((e) => e.name === element.name))}`;
  }
  if (!element.name && element.placeholder) return `page.getByPlaceholder(${q(element.placeholder)})`;
  if (!element.name) return `page.getByRole(${q(element.role)})${nth(element, all.filter((e) => e.role === element.role && !e.name))}`;
  const sameRole = all.filter((e) => e.role === element.role);
  const exact = sameRole.some((e) => e.name !== element.name && e.name.toLowerCase().includes(element.name.toLowerCase()));
  const twins = sameRole.filter((e) => e.name === element.name);
  return `page.getByRole(${q(element.role)}, { name: ${q(element.name)}${exact ? ", exact: true" : ""} })${nth(element, twins)}`;
}

function nth(element: SnapshotElement, twins: SnapshotElement[]): string {
  if (twins.length < 2) return "";
  const i = twins.indexOf(element);
  return i === 0 ? ".first()" : `.nth(${i})`;
}

/** One element as text: `button "Pay now"`, `link "Cart (1)" → /cart`, `textbox "Email" (placeholder …)`. */
export function describeElement(e: SnapshotElement): string {
  const bits = [e.role === "text" ? `text ${JSON.stringify(clip(e.name, 80))}` : `${e.role}${e.name ? ` ${JSON.stringify(clip(e.name, 80))}` : ""}`];
  if (e.level) bits.push(`[h${e.level}]`);
  if (e.url) bits.push(`→ ${e.url}`);
  if (e.placeholder) bits.push(`(placeholder ${JSON.stringify(e.placeholder)})`);
  if (e.disabled) bits.push("(disabled)");
  if (e.checked !== undefined) bits.push(`(checked: ${e.checked})`);
  if (e.clickable) bits.push("(clickable)");
  return bits.join(" ");
}

/** The snapshot as text: one line per element, controls with the locator a flow would use. */
export function formatSnapshot(snapshot: PageSnapshot, options: { max?: number } = {}): string {
  const max = options.max ?? 60;
  const lines = [`${snapshot.path}${snapshot.title ? `  "${snapshot.title}"` : ""}`];
  const shown = snapshot.elements.slice(0, max);
  for (const e of shown) {
    const control = CONTROL_ROLES.has(e.role) || e.clickable;
    lines.push(`  ${describeElement(e)}${e.near && control ? `  (under "${clip(e.near, 40)}")` : ""}${control ? `   ${locatorFor(e, snapshot.elements)}` : ""}`);
  }
  if (snapshot.elements.length > shown.length) lines.push(`  … ${snapshot.elements.length - shown.length} more`);
  return lines.join("\n");
}

function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** What a failed locator was waiting for, from Playwright's error message. */
export interface LocatorFailure {
  /** `click`, `fill`, `waitFor`… */
  action: string;
  /** Playwright's description: `getByRole('button', { name: 'Pay now' })`. */
  locator: string;
  /** More than one element matched (strict mode). */
  matched?: number;
  /** For waitFor: the state it waited for. */
  state?: string;
}

export function locatorFailure(message: string): LocatorFailure | undefined {
  const clean = message.replace(/\u001b\[[0-9;]*m/g, "");
  const action = /^\s*locator\.(\w+):/.exec(clean)?.[1];
  const waiting = /waiting for (.+?)(?: to be (visible|hidden|attached|detached))?\s*$/m.exec(clean);
  if (!action || !waiting) return undefined;
  const strict = /strict mode violation: .+? resolved to (\d+) elements/.exec(clean);
  return {
    action,
    locator: waiting[1]!.trim(),
    ...(strict ? { matched: Number(strict[1]) } : {}),
    ...(waiting[2] ? { state: waiting[2] } : {}),
  };
}

import { ATTR, type Screen, type ScreenNode, TAG, unescapeXml } from "../phone/screen.ts";

/** What a user taps on iOS: controls, and anything with the Button trait (a SwiftUI `onTapGesture` row has none). */
const CONTROLS = new Set(["Button", "Link", "Cell", "Switch", "Toggle", "MenuItem", "Tab", "SegmentedControl", "Stepper", "Slider"]);
const FIELDS = new Set(["TextField", "SecureTextField", "TextView", "SearchField"]);
/** Not part of the app's screen: the keyboard's keys would read as text. */
const SKIPPED = new Set(["Keyboard"]);
/** The keyboard has its own window, with its Emoji and Dictate buttons beside it: all of it is left out. */
const KEYBOARD = "Keyboard";

/** Parses XCUITest's page source (WebDriverAgent's). Nodes are in document order, which is reading order. */
export function parseIosScreen(xml: string): Screen {
  const nodes: ScreenNode[] = [];
  // The root (AppiumAUT) and nodes left out hold a place on the stack; under the keyboard, everything is left out.
  const stack: (ScreenNode | "root" | "hidden" | "skipped")[] = [];
  let width = 0;
  let height = 0;
  /** The app's windows, in order, and the one each node is in. */
  let window = -1;
  const windowOf = new Map<ScreenNode, number>();
  const keyboardWindows = new Set<number>();
  for (const m of xml.matchAll(TAG)) {
    const [, closing, name, attrText, selfClosing] = m;
    if (name === "?xml") continue;
    if (closing) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(ATTR)) attrs[a[1]!] = unescapeXml(a[2]!);
    const type = (attrs.type ?? name!).replace(/^XCUIElementType/, "");
    if (type === "Window" && stack.length === 2) window += 1;
    if (type === KEYBOARD) keyboardWindows.add(window);
    const mark =
      name === "AppiumAUT"
        ? "root"
        : stack.includes("skipped") || SKIPPED.has(type) || isScrollIndicator(type, attrs)
          ? "skipped"
          : attrs.visible === "false"
            ? "hidden"
            : undefined;
    if (mark) {
      if (!selfClosing) stack.push(mark);
      continue;
    }
    const top = stack.at(-1);
    const parent = typeof top === "object" && top.className !== "XCUIElementTypeApplication" ? top : undefined;
    const x = Number(attrs.x ?? 0);
    const y = Number(attrs.y ?? 0);
    const w = Number(attrs.width ?? 0);
    const h = Number(attrs.height ?? 0);
    if (type === "Application") {
      width = w;
      height = h;
    }
    const traits = (attrs.traits ?? "").split(/,\s*/);
    const field = FIELDS.has(type);
    const placeholder = (attrs.placeholderValue ?? "").trim();
    const value = (attrs.value ?? "").trim();
    const label = (attrs.label ?? "").trim();
    // A field's value is what was typed (an empty one shows its placeholder); anything else reads its label.
    // The app's own name (the Application node's label) isn't on its screen.
    const text = type === "Application" ? "" : field ? (value === placeholder ? "" : value) : label || (type === "StaticText" ? value : "");
    const node: ScreenNode = {
      className: `XCUIElementType${type}`,
      text,
      desc: field ? label : "",
      hint: placeholder,
      identifier: attrs.name && attrs.name !== label ? attrs.name : "",
      clickable: CONTROLS.has(type) || field || traits.includes("Button") || traits.includes("Link"),
      field,
      enabled: attrs.enabled !== "false",
      password: type === "SecureTextField",
      live: traits.includes("UpdatesFrequently"),
      bounds: [x, y, x + w, y + h],
      parent,
      children: [],
    };
    node.parent?.children.push(node);
    nodes.push(node);
    windowOf.set(node, window);
    if (!selfClosing) stack.push(node);
  }
  return { width, height, nodes: nodes.filter((n) => !keyboardWindows.has(windowOf.get(n)!)) };
}

/** A scroll view's indicator, which XCUITest lists as "Vertical scroll bar, 1 page". */
function isScrollIndicator(type: string, attrs: Record<string, string>): boolean {
  return type === "Other" && (attrs.traits ?? "").includes("Adjustable") && /scroll bar, \d+ pages?$/i.test(attrs.label ?? "");
}

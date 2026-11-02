import { ATTR, type Screen, type ScreenNode, TAG, unescapeXml } from "../phone/screen.ts";

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
    for (const a of attrText!.matchAll(ATTR)) attrs[a[1]!] = unescapeXml(a[2]!);
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
      identifier: attrs["resource-id"] ?? "",
      clickable: attrs.clickable === "true",
      field: (attrs.class ?? name) === "android.widget.EditText",
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

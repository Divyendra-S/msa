// Reading an iPhone's screen from XCUITest's page source (WebDriverAgent's): what a tap hits,
// which field a label names, what the user reads, and what isn't the app's.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseIosScreen } from "../src/ios/screen.ts";
import { findControl, findField, screenAlerts, screenTexts } from "../src/phone/screen.ts";

function el(type: string, attrs: Record<string, string | number>, children = ""): string {
  const all = { type: `XCUIElementType${type}`, enabled: "true", ...attrs };
  const text = Object.entries(all)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<XCUIElementType${type} ${text}>${children}</XCUIElementType${type}>` : `<XCUIElementType${type} ${text}/>`;
}

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

// As SwiftUI shows a login screen with the keyboard up: the keyboard, Emoji and Dictate in a
// window of their own, and a scroll view's indicators.
const LOGIN = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
${el(
  "Application",
  { name: "Shop", label: "Shop", ...rect(0, 0, 402, 874), traits: "" },
  [
    el(
      "Window",
      rect(0, 0, 402, 874),
      el("ScrollView", rect(0, 0, 402, 874), [
        el("StaticText", { value: "Log in", name: "Log in", label: "Log in", ...rect(20, 74, 95, 41), traits: "Header" }),
        el("TextField", { value: "alice@example.test", label: "", placeholderValue: "Email", ...rect(20, 126, 362, 35), traits: "" }),
        el("SecureTextField", { value: "••••", label: "", placeholderValue: "Password", ...rect(20, 172, 362, 35), traits: "" }),
        el("Button", { name: "Log in", label: "Log in", ...rect(20, 218, 70, 35), traits: "Button" }),
        el("StaticText", { value: "Wrong email &amp; password", name: "Wrong email &amp; password", label: "Wrong email &amp; password", ...rect(20, 265, 220, 20), traits: "UpdatesFrequently" }),
        el("Other", { value: "0%", name: "Vertical scroll bar, 1 page", label: "Vertical scroll bar, 1 page", ...rect(369, 62, 30, 750), traits: "Adjustable" }),
      ].join("")),
    ),
    el(
      "Window",
      rect(0, 0, 402, 874),
      [
        el("Button", { name: "Emoji", label: "Emoji", ...rect(8, 805, 69, 70), traits: "Button" }),
        el("Button", { name: "dictation", label: "Dictate", ...rect(325, 805, 69, 70), traits: "Button" }),
        el("Keyboard", rect(4, 573, 394, 243), el("Key", { name: "q", label: "q", ...rect(6, 580, 40, 50) })),
      ].join(""),
    ),
  ].join(""),
)}
</AppiumAUT>`;

const PRODUCTS = `<AppiumAUT>${el(
  "Application",
  { name: "Shop", label: "Shop", ...rect(0, 0, 402, 874) },
  el("Window", rect(0, 0, 402, 874), [
    el("StaticText", { value: "Products", label: "Products", ...rect(20, 62, 140, 41) }),
    el("Button", { name: "Cart", label: "Cart", ...rect(350, 68, 32, 30), traits: "Button" }),
    el("StaticText", { value: "Ceramic Mug", label: "Ceramic Mug", ...rect(20, 120, 120, 22) }),
    el("Button", { name: "Add Ceramic Mug to cart", label: "Add Ceramic Mug to cart", ...rect(270, 118, 112, 34), traits: "Button" }),
    el("StaticText", { value: "Wool Socks", label: "Wool Socks", ...rect(20, 180, 120, 22) }),
    el("Button", { name: "Add Wool Socks to cart", label: "Add Wool Socks to cart", enabled: "false", ...rect(270, 178, 112, 34), traits: "Button, NotEnabled" }),
    el("StaticText", { value: "Below the fold", label: "Below the fold", ...rect(20, 2000, 120, 22) }),
  ].join("")),
)}</AppiumAUT>`;

describe("an iPhone's screen", () => {
  it("reads the app's texts top to bottom: not its name, a password, the keyboard or the scroll bars", () => {
    const screen = parseIosScreen(LOGIN);
    assert.equal(screen.width, 402);
    assert.equal(screen.height, 874);
    assert.deepEqual(screenTexts(screen), ["Log in", "alice@example.test", "Log in", "Wrong email & password"]);
  });

  it("announces what updates frequently, as Android's live regions", () => {
    assert.deepEqual(screenAlerts(parseIosScreen(LOGIN)), ["Wrong email & password"]);
  });

  it("finds a field by its placeholder, and taps a button by its label", () => {
    const screen = parseIosScreen(LOGIN);
    const email = findField(screen, "Email");
    assert.ok(email.ok);
    assert.equal(email.value.node.className, "XCUIElementTypeTextField");
    assert.equal(email.value.node.text, "alice@example.test");
    const password = findField(screen, "password");
    assert.ok(password.ok);
    assert.equal(password.value.node.password, true);
    const button = findControl(screen, "Log in");
    assert.ok(button.ok);
    assert.deepEqual({ x: button.value.x, y: button.value.y }, { x: 55, y: 236 });
  });

  it("taps by accessibility label, and won't tap a disabled control or one below the screen", () => {
    const screen = parseIosScreen(PRODUCTS);
    assert.ok(findControl(screen, "Add Ceramic Mug to cart").ok);
    const disabled = findControl(screen, "Add Wool Socks to cart");
    assert.equal(disabled.ok, false);
    assert.match(disabled.ok ? "" : disabled.reason, /disabled/);
    assert.equal(screenTexts(screen).includes("Below the fold"), false);
  });

  it("reads an empty field as empty, not as its placeholder", () => {
    const empty = LOGIN.replace('value="alice@example.test"', 'value="Email"');
    const screen = parseIosScreen(empty);
    assert.equal(screenTexts(screen).includes("Email"), false);
    assert.ok(findField(screen, "Email").ok);
  });
});

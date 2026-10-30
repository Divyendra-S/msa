// Reading a phone's screen from UiAutomator's page source: what a tap hits, which field a label
// names, what the user reads.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findControl, findField, matchesText, parseScreen, screenAlerts, screenTexts, snapshotScreen } from "../src/android/screen.ts";

function node(cls: string, attrs: Record<string, string>, children = ""): string {
  const all = { class: cls, text: "", "content-desc": "", clickable: "false", enabled: "true", displayed: "true", ...attrs };
  const text = Object.entries(all)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<${cls} ${text}>${children}</${cls}>` : `<${cls} ${text} />`;
}

// As Compose shows a screen to UiAutomator: a field's label is a child of the field, a button's
// text a child of the clickable node.
const LOGIN = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0" width="720" height="1600">
${node("android.widget.FrameLayout", { bounds: "[0,0][720,1600]" }, [
  node("android.widget.TextView", { text: "Log in", bounds: "[40,24][192,96]" }),
  node("android.widget.EditText", { text: "alice@example.test", clickable: "true", bounds: "[40,120][680,248]" }, node("android.widget.TextView", { text: "Email", bounds: "[72,168][157,216]" })),
  node("android.widget.EditText", { text: "••••", password: "true", clickable: "true", bounds: "[40,272][680,400]" }, node("android.widget.TextView", { text: "Password", bounds: "[72,320][223,368]" })),
  node("android.view.View", { clickable: "true", bounds: "[40,424][216,520]" }, node("android.widget.TextView", { text: "Log in", bounds: "[88,452][168,492]" })),
  node("android.widget.TextView", { text: "Wrong email &amp; password", "live-region": "2", bounds: "[40,540][600,580]" }),
  node("android.widget.TextView", { text: "Scrolled away", bounds: "[0,0][0,0]" }),
  node("android.widget.TextView", { text: "Hidden", displayed: "false", bounds: "[40,600][600,640]" }),
].join("\n"))}
</hierarchy>`;

const PRODUCTS = `<hierarchy width="720" height="1600">
${["Ceramic Mug", "Wool Socks"]
  .map((name, i) =>
    node("android.view.View", { bounds: `[0,${200 + i * 100}][720,${300 + i * 100}]` }, [
      node("android.widget.TextView", { text: name, bounds: `[40,${210 + i * 100}][300,${250 + i * 100}]` }),
      node(
        "android.view.View",
        { "content-desc": `Add ${name} to cart`, clickable: "true", enabled: i === 1 ? "false" : "true", bounds: `[480,${210 + i * 100}][680,${290 + i * 100}]` },
        node("android.widget.TextView", { text: "Add to cart", bounds: `[500,${230 + i * 100}][660,${270 + i * 100}]` }),
      ),
    ].join("")),
  )
  .join("\n")}
</hierarchy>`;

describe("a phone's screen", () => {
  it("reads every text on screen, top to bottom, without passwords or what isn't shown", () => {
    const screen = parseScreen(LOGIN);
    assert.equal(screen.width, 720);
    assert.deepEqual(screenTexts(screen), ["Log in", "alice@example.test", "Email", "Password", "Log in", "Wrong email & password"]);
    assert.deepEqual(screenAlerts(screen), ["Wrong email & password"]);
  });

  it("taps the control a label names: the clickable node holding the text, not a heading with the same words", () => {
    const screen = parseScreen(LOGIN);
    const found = findControl(screen, "log in");
    assert.ok(found.ok);
    assert.deepEqual({ x: found.value.x, y: found.value.y }, { x: 128, y: 472 });
    assert.equal(findControl(screen, "Sign up").ok, false);
  });

  it("tells repeated controls apart by their accessibility labels, and won't tap a disabled one", () => {
    const screen = parseScreen(PRODUCTS);
    const mug = findControl(screen, "Add Ceramic Mug to cart");
    assert.ok(mug.ok && mug.value.y === 250);
    const both = findControl(screen, "Add to cart");
    assert.deepEqual(both, { ok: false, reason: '2 controls are labelled "Add to cart": give each its own accessibility label' });
    assert.deepEqual(findControl(screen, "Add Wool Socks to cart"), { ok: false, reason: '"Add Wool Socks to cart" is disabled' });
  });

  it("finds a text field by the label Compose draws inside it, and counts fields for finding it again", () => {
    const screen = parseScreen(LOGIN);
    const password = findField(screen, "Password");
    assert.ok(password.ok && password.value.index === 1);
    assert.equal(findField(screen, "Log in").ok, false);
  });

  it("matches text as a user would: any text containing it, ignoring case, or a pattern", () => {
    assert.equal(matchesText("Order  confirmed", "order confirmed"), true);
    assert.equal(matchesText("Limited Print is out of stock", /out of stock|Order confirmed/), true);
    assert.equal(matchesText("Processing payment…", "Order confirmed"), false);
  });

  it("snapshots the screen's controls and texts for locator repair", () => {
    const snapshot = snapshotScreen(parseScreen(LOGIN), "", "dev.windtunnel.shop");
    assert.deepEqual(
      snapshot.elements.map((e) => `${e.role} ${e.name}`),
      ["text Log in", "textbox Email", "textbox Password", "button Log in", "text Wrong email & password"],
    );
  });
});

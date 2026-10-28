import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { flattenAria, formatSnapshot, locatorFailure, locatorFor, type PageSnapshot } from "../src/runner/snapshot.ts";
import { estimateTokens, formatUsage, UsageMeter } from "../src/usage.ts";

// The shape page.ariaSnapshotJSON({ mode: "ai" }) returns (refs and cursors included).
const TREE = [
  {
    role: "generic",
    ref: "e1",
    children: [
      { role: "banner", children: [{ role: "link", name: "Cart (1)", url: "/cart", cursor: "pointer" }, "Alice", { role: "button", name: "Log out" }] },
      {
        role: "main",
        children: [
          { role: "heading", name: "Products", level: 1 },
          { role: "heading", name: "Ceramic Mug", level: 2 },
          "Holds 350 ml.",
          { role: "button", name: "Add to cart", cursor: "pointer" },
          { role: "heading", name: "Wool Socks", level: 2 },
          { role: "button", name: "Add to cart", cursor: "pointer" },
          { role: "generic", children: ["Email", { role: "textbox", name: "Email" }] },
          { role: "textbox", placeholder: "Search" },
          { role: "button", name: "Pay" },
          { role: "button", name: "Pay later" },
          { role: "generic", name: "", text: "Clear", cursor: "pointer" },
          { role: "paragraph", text: "Your cart is empty." },
        ],
      },
      { role: "alert" },
    ],
  },
];

describe("page snapshot", () => {
  const elements = flattenAria(TREE);
  const snapshot: PageSnapshot = { path: "/", title: "Shop", elements };

  it("flattens controls and texts in page order, with the heading above each", () => {
    const controls = elements.filter((e) => e.role === "button").map((e) => `${e.name}${e.near ? ` < ${e.near}` : ""}`);
    assert.deepEqual(controls, ["Log out", "Add to cart < Ceramic Mug", "Add to cart < Wool Socks", "Pay < Wool Socks", "Pay later < Wool Socks"]);
    assert.ok(elements.some((e) => e.role === "text" && e.name === "Holds 350 ml."));
    assert.ok(elements.some((e) => e.role === "paragraph" && e.name === "Your cart is empty."));
    assert.ok(elements.some((e) => e.clickable && e.name === "Clear"));
    assert.equal(elements.find((e) => e.role === "link")?.url, "/cart");
  });

  it("writes the locator a flow would use: exact for prefixes, nth for twins, placeholder when unnamed", () => {
    const find = (role: string, name: string, i = 0) => elements.filter((e) => e.role === role && e.name === name)[i]!;
    assert.equal(locatorFor(find("button", "Pay"), elements), 'page.getByRole("button", { name: "Pay", exact: true })');
    assert.equal(locatorFor(find("button", "Pay later"), elements), 'page.getByRole("button", { name: "Pay later" })');
    assert.equal(locatorFor(find("button", "Add to cart", 1), elements), 'page.getByRole("button", { name: "Add to cart" }).nth(1)');
    assert.equal(locatorFor(find("button", "Add to cart", 0), elements), 'page.getByRole("button", { name: "Add to cart" }).first()');
    assert.equal(locatorFor(elements.find((e) => e.placeholder)!, elements), 'page.getByPlaceholder("Search")');
    assert.equal(locatorFor(elements.find((e) => e.clickable)!, elements), 'page.getByText("Clear")');
    const text = formatSnapshot(snapshot);
    assert.match(text, /button "Add to cart" {2}\(under "Wool Socks"\) {3}page\.getByRole\("button", \{ name: "Add to cart" \}\)\.nth\(1\)/);
  });

  it("reads what a failed locator waited for from Playwright's error", () => {
    const timeout = "locator.click: Timeout 10000ms exceeded.\nCall log:\n\u001b[2m  - waiting for getByRole('button', { name: 'Pay now' })\u001b[22m\n";
    assert.deepEqual(locatorFailure(timeout), { action: "click", locator: "getByRole('button', { name: 'Pay now' })" });
    const strict =
      "locator.click: Error: strict mode violation: getByRole('button', { name: 'Add to cart' }) resolved to 2 elements:\n    1) <button>…\n\nCall log:\n  - waiting for getByRole('button', { name: 'Add to cart' })\n";
    assert.equal(locatorFailure(strict)?.matched, 2);
    const wait = "locator.waitFor: Timeout 500ms exceeded.\nCall log:\n  - waiting for getByText('Order confirmed').or(getByLabel('Email')) to be visible\n";
    assert.deepEqual(locatorFailure(wait), { action: "waitFor", locator: "getByText('Order confirmed').or(getByLabel('Email'))", state: "visible" });
    assert.equal(locatorFailure("page.waitForURL: Timeout 10000ms exceeded."), undefined);
  });
});

describe("usage meter", () => {
  it("counts tool output and decisions per job, and keeps them across processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-usage-"));
    try {
      const meter = new UsageMeter(dir, "job-1");
      await meter.tool("windtunnel_map", "x".repeat(4000), 12);
      await meter.record({ kind: "decision", name: "selector", ms: 0, by: "rules" });
      await meter.record({ kind: "decision", name: "triage", ms: 300, by: "spark", inputTokens: 600, outputTokens: 40, usd: 0.00092 });
      await meter.record({ kind: "decision", name: "triage:unsure", ms: 280, inputTokens: 500, outputTokens: 30, usd: 0.0007 });
      const totals = meter.totals();
      assert.equal(totals.toolCalls, 1);
      assert.equal(totals.tokens, estimateTokens("x".repeat(4000)));
      assert.deepEqual(totals.decisions, { rules: 1, spark: 1, jev: 0, agent: 0 });
      assert.equal(Math.round(totals.usd * 1e5), 162);
      assert.match(formatUsage(totals, { tokens: 150_000, usd: 0.5 }), /usage so far \(job job-1\): 1 tool output\(s\) ≈ 1\.0k tokens \(budget 150\.0k\) · decisions: 1 by rules, 1 by Muse Spark \(\$0\.0016 of \$0\.5\)/);

      const again = new UsageMeter(dir, "job-1");
      await again.load();
      assert.equal(again.totals().toolCalls, 1);
      assert.ok((await readFile(again.file, "utf8")).split("\n").filter(Boolean).length === 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

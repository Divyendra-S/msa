// Reading an iOS app: its SwiftUI screens and the server calls their actions lead to.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { findIosApp } from "../src/ios.ts";

const API = `import Foundation

final class ShopApi {
    // A brace in a comment: {
    func pay(cartId: Int) async throws -> Int {
        let body: Placed = try await call("POST", "/api/orders", body: ["cartId": cartId])
        return body.orderId
    }

    func orderStatus(_ id: Int) async throws -> String {
        let body: Status = try await call("GET", "/api/orders/\\(id)")
        return body.status
    }

    private func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        let url = "\\(base){"
        fatalError()
    }
}
`;

const MODEL = `import Observation

@Observable
final class ShopModel {
    func pay() {
        Task { _ = try await api.pay(cartId: 1) }
    }
}
`;

const SCREENS = `import SwiftUI

struct CartScreen: View {
    let model: ShopModel

    var body: some View {
        Text("Cart").font(.largeTitle)
        Text("Total: \\(price(cart.totalCents))")
        Text("\\(n > 0 ? "\\(n) left" : "Sold out")")
        TextField("Coupon", text: $coupon)
        Button(model.paying ? "Paying…" : "Pay now") { model.pay() }
            .accessibilityLabel("Pay for the cart")
    }
}

private struct Badge: View {
    var body: some View { Text("New") }
}
`;

describe("findIosApp", () => {
  let root: string;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-ios-"));
    const files: Record<string, string> = {
      "Shop.xcodeproj/project.pbxproj": "// !$*UTF8*$!",
      "Shop/ShopApi.swift": API,
      "Shop/ShopModel.swift": MODEL,
      "Shop/Screens.swift": SCREENS,
      "build/Copy/Screens.swift": SCREENS.replace("CartScreen", "BuiltScreen"),
    };
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the calls, the function each is in, with interpolations as {name}", async () => {
    const app = await findIosApp(root);
    assert.equal(app?.framework, "iOS (SwiftUI)");
    assert.deepEqual(
      app!.calls.map((c) => `${c.method} ${c.path} ${c.fn} ${c.file}:${c.line}`),
      ["POST /api/orders pay Shop/ShopApi.swift:6", "GET /api/orders/{id} orderStatus Shop/ShopApi.swift:11"],
    );
  });

  it("reads each screen's buttons, fields and texts, and the calls its actions lead to", async () => {
    const app = await findIosApp(root);
    assert.deepEqual(app!.screens.map((s) => s.name), ["CartScreen"]);
    const [cart] = app!.screens;
    assert.deepEqual(cart!.ui.buttons, ["Paying…", "Pay now", "Pay for the cart"]);
    assert.deepEqual(cart!.ui.fields, ["Coupon"]);
    assert.deepEqual(cart!.ui.texts, ["Cart", "Total: {price(cart.totalCents)}", '{n > 0 ? "\\(n) left" : "Sold out"}']);
    assert.deepEqual(cart!.ui.requests, [{ method: "POST", url: "/api/orders" }]);
  });

  it("is no iOS app without an Xcode project or a Swift package", async () => {
    assert.equal(await findIosApp(join(root, "Shop")), undefined);
  });
});

// Reading an Android app: its screens, the server calls its code makes, and the map that joins
// them to the server's routes in another folder.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Project } from "@windtunnel/core";
import { findAndroidApp } from "../src/android.ts";
import { buildAppMap, formatAppMap } from "../src/map.ts";

const API = `package shop

class Api(private val base: String) {
    // A brace in a comment: {
    fun pay(cartId: Int): Int = call("POST", "/api/orders", JSONObject().put("cartId", cartId)).getInt("orderId")

    fun status(id: Int): String = call("GET", "/api/orders/$id").getString("status")

    private fun call(method: String, path: String, body: JSONObject? = null): JSONObject {
        val url = "\${base}{"
        return JSONObject()
    }
}

interface Catalogue {
    @GET("api/products")
    suspend fun products(): List<Product>
}
`;

const MODEL = `package shop

class Model(private val api: Api) : ViewModel() {
    var paying by mutableStateOf(false)

    fun pay() {
        viewModelScope.launch { api.pay(1) }
    }
}
`;

const SCREENS = `package shop

@Composable
fun CartScreen(model: Model) {
    Text("Cart", style = MaterialTheme.typography.headlineMedium)
    OutlinedTextField(value = note, onValueChange = {}, label = { Text("Note") })
    Button(onClick = model::pay, enabled = !model.paying) { Text(if (model.paying) "Paying…" else "Pay now") }
    for (p in products) {
        Button(onClick = {}, modifier = Modifier.semantics { contentDescription = "Remove \${p.name}" }) { Text("Remove") }
    }
    val status = when (model.status) { "paid" -> "Order confirmed"; else -> "Processing payment…" }
}

@Composable
private fun Row() {}
`;

const FILES: Record<string, string> = {
  "phone/app/src/main/AndroidManifest.xml": "<manifest />",
  "phone/app/build.gradle.kts": "android { buildFeatures { compose = true } }",
  "phone/app/src/main/java/shop/Api.kt": API,
  "phone/app/src/main/java/shop/Model.kt": MODEL,
  "phone/app/src/main/java/shop/Screens.kt": SCREENS,
  "phone/app/build/generated/Junk.kt": 'fun junk() = call("DELETE", "/api/everything")',
  "server/package.json": '{ "dependencies": { "next": "16.0.0" } }',
  "server/app/api/orders/route.ts": "export async function POST() { return Response.json({}); }",
  "server/app/api/orders/[id]/route.ts": "export async function GET() { return Response.json({}); }",
};

describe("an Android app", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-android-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("finds the server calls its code makes, by helper and by Retrofit annotation, with their function", async () => {
    const app = (await findAndroidApp(join(root, "phone")))!;
    assert.equal(app.framework, "Android (Jetpack Compose)");
    assert.deepEqual(
      app.calls.map((c) => `${c.method} ${c.path} ${c.fn} ${c.file}:${c.line}`),
      [
        `POST /api/orders pay ${join("app", "src", "main", "java", "shop", "Api.kt")}:5`,
        `GET /api/orders/{id} status ${join("app", "src", "main", "java", "shop", "Api.kt")}:7`,
        `GET /api/products products ${join("app", "src", "main", "java", "shop", "Api.kt")}:16`,
      ],
    );
  });

  it("reads each screen's buttons, field labels and texts, and the calls its actions lead to", async () => {
    const app = (await findAndroidApp(join(root, "phone")))!;
    assert.deepEqual(app.screens.map((s) => s.name), ["CartScreen"]);
    const ui = app.screens[0]!.ui;
    assert.deepEqual(ui.buttons, ["Paying…", "Pay now", "Remove", "Remove {p.name}"]);
    assert.deepEqual(ui.fields, ["Note"]);
    assert.deepEqual(ui.texts, ["Cart", "Order confirmed", "Processing payment…"]);
    assert.deepEqual(ui.requests, [{ method: "POST", url: "/api/orders" }]);
  });

  it("maps the server in app.dir, notes which routes the phone calls, and lists the screens", async () => {
    const project = {
      root: join(root, "phone"),
      repoRoot: root,
      appSubdir: "phone",
      stateDir: join(root, "phone", ".windtunnel"),
      config: { app: { kind: "android", dir: "../server" }, android: { dir: "." }, users: {} },
    } as unknown as Project;
    const map = await buildAppMap(project);
    assert.match(map.framework, /^Android \(Jetpack Compose\) \+ Next\.js/);
    const pay = map.routes.find((r) => r.method === "POST" && r.path === "/api/orders")!;
    assert.equal(pay.file, join("..", "server", "app", "api", "orders", "route.ts"));
    assert.deepEqual(pay.notes, [`called by the phone app: pay (${join("app", "src", "main", "java", "shop", "Api.kt")}:5)`]);
    assert.match(map.routes.find((r) => r.path === "/api/orders/:id")!.notes.join(), /called by the phone app: status/);
    const text = formatAppMap(map);
    assert.match(text, /Screens \(1\): .*\nCartScreen {2}app\/src\/main\/java\/shop\/Screens\.kt:4 {2}fields "Note"/);
  });
});

// The HTTP proxy seam against a real server: what the app and the client each see.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { allocatePort } from "../src/ports.ts";
import { parseExperiment } from "../src/runner/experiment.ts";
import { Network, type NetworkTab, newGroup } from "../src/runner/network.ts";
import { HttpProxy, TAB_HEADER } from "../src/runner/proxy.ts";

interface Seen {
  method: string;
  url: string;
  host?: string;
  tab?: string;
  body: string;
}

describe("HTTP proxy", () => {
  const seen: Seen[] = [];
  let app: http.Server;
  let appUrl: string;
  let proxy: HttpProxy;

  before(async () => {
    app = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, host: req.headers.host, tab: req.headers[TAB_HEADER] as string | undefined, body });
        if (req.url === "/redirect") {
          res.writeHead(303, { location: `${appUrl}/landing?x=1` });
          return res.end();
        }
        if (req.url === "/cookies") {
          res.writeHead(200, [["set-cookie", "a=1; Path=/"], ["set-cookie", "b=2; Path=/"]].flat());
          return res.end("ok");
        }
        if (req.url === "/slow") return void setTimeout(() => res.end("slow"), 200);
        res.writeHead(req.method === "POST" ? 201 : 200, { "content-type": "text/plain" });
        res.end(`${req.method} ${req.url} ${body}`);
      });
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", () => resolve()));
    appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    proxy = await HttpProxy.start({ port: await allocatePort(), target: appUrl });
  });

  after(async () => {
    await proxy.close();
    await new Promise((r) => app.close(r));
  });

  const send = (path: string, init: RequestInit & { tab?: string } = {}) =>
    fetch(`${proxy.url}${path}`, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), ...(init.tab ? { [TAB_HEADER]: init.tab } : {}) },
    });

  it("passes calls straight through before a run attaches, keeping the proxy's Host", async () => {
    seen.length = 0;
    const res = await send("/hello?q=1", { method: "POST", body: "hi", tab: "alice" });
    assert.equal(res.status, 201);
    assert.equal(await res.text(), "POST /hello?q=1 hi");
    assert.equal(res.headers.get("connection"), "close");
    assert.deepEqual(seen, [{ method: "POST", url: "/hello?q=1", host: new URL(proxy.url).host, tab: undefined, body: "hi" }]);
  });

  it("rewrites redirects to the app's own address and keeps every cookie", async () => {
    const redirect = await send("/redirect");
    assert.equal(redirect.headers.get("location"), `${proxy.url}/landing?x=1`);
    const cookies = await send("/cookies");
    assert.deepEqual(cookies.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  });

  describe("attached to a run", () => {
    const alice: NetworkTab = { label: "alice", group: newGroup(), stepName: "pay", takeRefresh: () => false, reload: async () => undefined };
    const unknown = newGroup();
    let network: Network;

    before(() => {
      const experiment = parseExperiment(
        `flow: pay
perturb:
  - { do: fail, request: POST /api/fail, status: 502 }
  - { do: lose-response, request: POST /api/lost }
  - { do: duplicate, request: POST /api/twice }`,
        "x.yaml",
        "x",
      );
      network = new Network({ t0: Date.now(), perturbations: experiment.perturb as never, client: "app" });
      proxy.attach({ network, tabOf: (label) => (label === "alice" ? alice : undefined), group: unknown });
    });
    after(() => proxy.detach());

    it("logs each call under the tab its header names, and the app never sees the header", async () => {
      seen.length = 0;
      const res = await send("/api/items", { method: "POST", body: "x", tab: "alice" });
      assert.equal(res.status, 201);
      await res.text();
      const record = network.log.at(-1)!;
      assert.equal(record.tab, "alice");
      assert.equal(record.step, "pay");
      assert.equal(record.url, "/api/items");
      assert.equal(record.status, 201);
      assert.equal(record.type, "fetch");
      assert.ok(record.end !== undefined && record.response !== undefined);
      assert.equal(seen[0]!.tab, undefined);
    });

    it("answers for the app, loses its answer, or sends a call twice", async () => {
      seen.length = 0;
      const failed = await send("/api/fail", { method: "POST", tab: "alice" });
      assert.equal(failed.status, 502);
      assert.equal(await failed.text(), "Service unavailable (injected)");
      assert.equal(seen.length, 0, "the app never saw the failed call");

      await assert.rejects(send("/api/lost", { method: "POST", body: "pay", tab: "alice" }), TypeError);
      assert.deepEqual(seen.map((s) => `${s.method} ${s.url} ${s.body}`), ["POST /api/lost pay"], "the app got the lost call once");
      const lost = network.log.find((r) => r.url === "/api/lost")!;
      assert.equal(lost.failure, "connection reset by the harness");
      assert.match(lost.harness!.join(), /the app saw a network error/);

      seen.length = 0;
      const twice = await send("/api/twice", { method: "POST", body: "b", tab: "alice" });
      assert.equal(await twice.text(), "POST /api/twice b");
      assert.equal(seen.length, 2);
    });

    it("counts calls in flight for step timing, under the port's group for unknown tabs", async () => {
      const slow = send("/slow");
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(unknown.busy, 1);
      assert.equal(network.log.at(-1)!.tab, "?");
      await (await slow).text();
      assert.equal(await network.quiet(unknown, 20, 500), true);
    });

    it("leaves scripts and images out of the log", async () => {
      const before = network.log.length;
      await (await send("/app.js", { headers: { "sec-fetch-dest": "script" }, tab: "alice" })).text();
      await (await send("/", { headers: { "sec-fetch-dest": "document" }, tab: "alice" })).text();
      assert.deepEqual(network.log.slice(before).map((r) => `${r.type} ${r.url}`), ["document /"]);
    });

    it("logs a Tauri page's command calls by name, and leaves its event stream and own script out", async () => {
      const before = network.log.length;
      await (await send("/__windtunnel/invoke/save_note", { method: "POST", body: "{}", tab: "alice" })).text();
      await (await send("/__windtunnel/invoke/plugin%3Aevent%7Cemit", { method: "POST", body: "{}", tab: "alice" })).text();
      await (await send("/__windtunnel/listen", { method: "POST", body: "{}", tab: "alice" })).text();
      await (await send("/events", { headers: { accept: "text/event-stream" }, tab: "alice" })).text();
      assert.deepEqual(network.log.slice(before).map((r) => `${r.method} ${r.url}`), ["INVOKE save_note", "INVOKE plugin:event|emit"]);
      assert.equal(alice.group.busy, 0);
    });
  });
});

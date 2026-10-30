// The seam's logic with a fake transport: what happens to a call, whatever carries it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseExperiment } from "../src/runner/experiment.ts";
import { type Answer, type Call, Network, type NetworkTab, newGroup, type RaceRecord } from "../src/runner/network.ts";

/** Everything a transport was asked to do, in order, across calls. */
const events: string[] = [];

class FakeCall implements Call {
  readonly method: string;
  readonly url: string;
  readonly headers = {};
  readonly tracked = true;
  readonly name: string;
  appCalls = 0;
  private readonly status: number;
  private readonly appMs: number;

  constructor(name: string, method: string, path: string, options: { status?: number; appMs?: number } = {}) {
    this.name = name;
    this.method = method;
    this.url = `http://app.test${path}`;
    this.status = options.status ?? 200;
    this.appMs = options.appMs ?? 0;
  }

  async send(): Promise<Answer> {
    this.appCalls += 1;
    events.push(`${this.name} send`);
    await new Promise((r) => setTimeout(r, this.appMs));
    return { status: this.status };
  }
  async answer(answer: Answer) {
    events.push(`${this.name} answer ${answer.status}`);
  }
  async fulfill(status: number) {
    events.push(`${this.name} fulfill ${status}`);
  }
  async drop() {
    events.push(`${this.name} drop`);
  }
  async pass() {
    this.appCalls += 1;
    events.push(`${this.name} pass`);
  }
}

function tab(label: string, stepName = "pay"): NetworkTab {
  return { label, group: newGroup(), stepName, takeInterruption: () => undefined, interrupt: async () => undefined };
}

/** A Network for an experiment written as YAML. */
function network(yaml: string, tabs = 2): Network {
  const experiment = parseExperiment(`flow: pay\n${yaml}`, "x.yaml", "x");
  const race = experiment.race;
  return new Network({
    t0: Date.now(),
    perturbations: experiment.perturb.filter((p) => "request" in p) as never,
    race: race && { ...race, count: race.count ?? Math.max(2, tabs), order: race.order as never },
  });
}

async function handle(net: Network, call: FakeCall, from: NetworkTab) {
  const record = net.record({ tab: from.label, step: from.stepName, method: call.method, url: new URL(call.url).pathname, type: "fetch" });
  net.opened(record, from.group);
  await net.handle(call, from, record);
  return record;
}

describe("network seam", () => {
  it("lets calls through untouched when nothing applies", async () => {
    events.length = 0;
    const net = network("perturb: [{ do: fail, request: POST /api/orders }]");
    const call = new FakeCall("a", "GET", "/api/orders");
    await handle(net, call, tab("alice"));
    assert.deepEqual(events, ["a pass"]);
    assert.deepEqual(net.unused().map((p) => p.do), ["fail"]);
    assert.equal(net.wants(new URL("http://app.test/api/orders")), true);
    assert.equal(net.wants(new URL("http://app.test/cart")), false);
  });

  it("fail, lose-response and duplicate, each on the first matching call only", async () => {
    events.length = 0;
    const net = network(`perturb:
  - { do: fail, request: POST /api/a, status: 502 }
  - { do: lose-response, request: POST /api/b }
  - { do: duplicate, request: POST /api/c }`);
    const alice = tab("alice");
    const a = await handle(net, new FakeCall("a", "POST", "/api/a"), alice);
    const b = await handle(net, new FakeCall("b", "POST", "/api/b", { status: 201 }), alice);
    const c = new FakeCall("c", "POST", "/api/c");
    await handle(net, c, alice);
    await handle(net, new FakeCall("a2", "POST", "/api/a"), alice);
    assert.deepEqual(events, ["a fulfill 502", "b send", "b drop", "c send", "c send", "c answer 200", "a2 pass"]);
    assert.equal(a.sent, null, "the app never saw the failed call");
    assert.match(b.harness!.join(), /response lost: the app answered 201, the browser saw a network error/);
    assert.equal(c.appCalls, 2);
    assert.deepEqual(net.unused(), []);
  });

  it("a perturbation limited to a step or a tab leaves the others alone", async () => {
    events.length = 0;
    const net = network(`perturb:
  - { do: fail, request: POST /api/a, step: confirm }
  - { do: fail, request: POST /api/b, tab: bob }`);
    await handle(net, new FakeCall("a", "POST", "/api/a"), tab("alice", "pay"));
    await handle(net, new FakeCall("b", "POST", "/api/b"), tab("alice"));
    await handle(net, new FakeCall("b2", "POST", "/api/b"), tab("bob"));
    assert.deepEqual(events, ["a pass", "b pass", "b2 fulfill 503"]);
  });

  it("holds race calls until they all arrive, then releases them one by one in the order asked", async () => {
    events.length = 0;
    const net = network("race: { request: POST /api/orders, order: [bob, alice] }");
    const alice = tab("alice");
    const bob = tab("bob");
    const first = handle(net, new FakeCall("alice", "POST", "/api/orders", { appMs: 20 }), alice);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(events, [], "the first call waits for the second");
    assert.equal(await net.quiet(alice.group, 20, 200), true, "a held call doesn't keep its step waiting");
    await Promise.all([first, handle(net, new FakeCall("bob", "POST", "/api/orders", { appMs: 20 }), bob)]);
    assert.deepEqual(events, ["bob send", "bob answer 200", "alice send", "alice answer 200"]);
    assert.deepEqual(net.race, {
      request: "POST /api/orders",
      arrived: [
        { tab: "alice", arrival: 1, step: "pay" },
        { tab: "bob", arrival: 2, step: "pay" },
      ],
      released: ["bob (arrival 2)", "alice (arrival 1)"],
      timedOut: false,
    } satisfies RaceRecord);
  });

  it("releases what arrived after the race timeout", async () => {
    events.length = 0;
    const net = network("race: { request: POST /api/orders, timeout: 50ms }");
    await handle(net, new FakeCall("alice", "POST", "/api/orders"), tab("alice"));
    assert.deepEqual(events, ["alice send", "alice answer 200"]);
    assert.equal(net.race?.timedOut, true);
    await handle(net, new FakeCall("late", "POST", "/api/orders"), tab("bob"));
    assert.deepEqual(events.slice(2), ["late pass"], "after the release, calls pass");
  });

  it("a step waits for its group's calls in flight, not for other groups'", async () => {
    const net = network("");
    const alice = tab("alice");
    const bob = tab("bob");
    const record = net.record({ tab: "alice", method: "GET", url: "/", type: "document" });
    net.opened(record, alice.group);
    assert.equal(await net.quiet(alice.group, 20, 100), false);
    assert.equal(await net.quiet(bob.group, 20, 100), true);
    assert.equal(net.settle(record, "gone"), true);
    assert.equal(net.settle(record), false, "settled once");
    assert.equal(record.failure, "gone");
    assert.equal(await net.quiet(alice.group, 20, 100), true);
  });
  it("an offline phone's calls fail without reaching the app", async () => {
    events.length = 0;
    const net = new Network({ t0: Date.now(), perturbations: [], client: "phone" });
    net.offline.add("alice");
    const record = await handle(net, new FakeCall("a", "POST", "/api/orders"), tab("alice"));
    await handle(net, new FakeCall("b", "POST", "/api/orders"), tab("bob"));
    assert.deepEqual(events, ["a drop", "b pass"]);
    assert.equal(record.sent, null);
    assert.match(record.harness!.join(), /the phone was offline/);
  });

  it("kill-app: the app dies while the server answers, and is opened again; the step waits for both", async () => {
    events.length = 0;
    const net = new Network({ t0: Date.now(), perturbations: [], client: "phone" });
    let armed = true;
    const alice: NetworkTab = {
      label: "alice",
      group: newGroup(),
      stepName: "pay",
      takeInterruption: () => (armed ? ((armed = false), "kill-app") : undefined),
      interrupt: async (what, phase) => {
        events.push(`${what} ${phase}`);
        if (phase === "end") await new Promise((r) => setTimeout(r, 40));
      },
    };
    const record = net.record({ tab: "alice", step: "pay", method: "POST", url: "/api/orders", type: "fetch" });
    net.opened(record, alice.group);
    const handled = net.handle(new FakeCall("a", "POST", "/api/orders", { appMs: 10 }), alice, record);
    net.settle(record, "canceled by the client");
    assert.equal(await net.quiet(alice.group, 10, 20), false, "busy until the app is open again");
    await handled;
    assert.deepEqual(events, ["a send", "kill-app start", "a drop", "kill-app end"]);
    assert.equal(await net.quiet(alice.group, 10, 100), true);
    await handle(net, new FakeCall("b", "POST", "/api/orders"), alice);
    assert.equal(events.at(-1), "b pass", "only the step's first call is interrupted");
  });
});

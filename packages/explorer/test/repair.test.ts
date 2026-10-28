// Selector repair without a browser: Playwright's locator text, the matching call in a flow file,
// candidates on a page snapshot, and the Decider's levels (rules, a Level 1 model over HTTP, the agent).
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { flattenAria, type PageSnapshot, UsageMeter } from "@windtunnel/core";
import { Decider, DecisionStore, Jev, MuseSpark, type Question } from "../src/decider.ts";
import { findInSource, parseLocator, rankCandidates, replaceInSource, restoreSource, rulesPick, similarity, withExact } from "../src/repair.ts";

const FLOW = `import { flow } from "windtunnel";
export default flow(async ({ page, step, params }) => {
  const product = params.product ?? "Mug";
  await step("add", async () => {
    const card = page.locator(".card", { has: page.getByRole("heading", { name: product }) });
    await card.getByRole("button", { name: "Add to cart" }).click();
  });
  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());
  await step("again", () => page.getByRole('button', { name: 'Pay now' }).click());
  await step("done", () => page.getByText(/order confirmed/i).waitFor());
});
`;

const CART: PageSnapshot = {
  path: "/cart",
  title: "Shop",
  elements: flattenAria([
    { role: "link", name: "Cart (1)", url: "/cart" },
    { role: "button", name: "Log out" },
    { role: "heading", name: "Cart", level: 1 },
    { role: "button", name: "Remove" },
    { role: "button", name: "Place order" },
    { role: "paragraph", text: "Total: $14.00" },
  ]),
};

describe("locators", () => {
  it("parses Playwright's locator text, chains, regexes and composites", () => {
    const simple = parseLocator("getByRole('button', { name: 'Pay now', exact: true })")!;
    assert.deepEqual(simple.target, {
      method: "getByRole",
      args: [{ type: "string", value: "button" }, { type: "object", props: { name: { type: "string", value: "Pay now" }, exact: { type: "bool", value: true } } }],
    });
    const chained = parseLocator("locator('.card').filter({ has: getByRole('heading', { name: 'Mug' }) }).getByRole('button', { name: 'Buy' }).first()")!;
    assert.equal(chained.target?.method, "getByRole");
    assert.deepEqual(chained.calls.map((c) => c.method), ["locator", "filter", "getByRole", "first"]);
    assert.deepEqual(parseLocator("getByText(/order confirmed/i)")!.target!.args[0], { type: "regex", source: "order confirmed", flags: "i" });
    assert.equal(parseLocator("getByText('Order confirmed').or(getByLabel('Email'))")!.composite, true);
    assert.equal(parseLocator("getByText('It\\'s done')")!.target!.args[0]!.type === "string" && (parseLocator("getByText('It\\'s done')")!.target!.args[0] as { value: string }).value, "It's done");
    assert.equal(parseLocator("getByRole('button'"), undefined);
  });

  it("finds the call in the flow file, edits every literal copy in its quote style, and restores it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-repair-"));
    const file = join(dir, "checkout.ts");
    try {
      await writeFile(file, FLOW);
      const pay = parseLocator("getByRole('button', { name: 'Pay now' })")!.target!;
      const matches = await findInSource([file], pay);
      assert.deepEqual(matches.map((m) => [m.line, m.dynamic, m.quote]), [[8, false, '"'], [9, false, "'"]]);
      const dynamic = await findInSource([file], parseLocator("getByRole('heading', { name: 'Mug' })")!.target!);
      assert.deepEqual(dynamic.map((m) => [m.line, m.dynamic]), [[5, true]]);
      const regex = await findInSource([file], parseLocator("getByText(/order confirmed/i)")!.target!);
      assert.equal(regex.length, 1);

      const saved = await replaceInSource(matches, 'getByRole("button", { name: "Place order" })');
      const edited = await readFile(file, "utf8");
      assert.match(edited, /step\("pay", \(\) => page\.getByRole\("button", \{ name: "Place order" \}\)\.click\(\)\)/);
      assert.match(edited, /step\("again", \(\) => page\.getByRole\('button', \{ name: 'Place order' \}\)\.click\(\)\)/);
      await restoreSource(saved);
      assert.equal(await readFile(file, "utf8"), FLOW);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ranks look-alikes on the page; rules are only sure about clear cases", () => {
    assert.equal(similarity("Pay now", "pay now →"), 1);
    assert.ok(similarity("Add to cart", "Add to basket") > similarity("Add to cart", "Remove"));
    const pay = parseLocator("getByRole('button', { name: 'Pay now' })")!.target!;
    const candidates = rankCandidates(pay, CART, "click");
    // Log out and Remove are never offered in place of something else.
    assert.deepEqual(candidates.map((c) => c.code), ['getByRole("button", { name: "Place order" })']);
    assert.deepEqual(rulesPick(candidates, { action: "click", call: pay }), { index: 0, confidence: 0.8 });

    const renamed = rankCandidates(parseLocator("getByRole('button', { name: 'Place an order' })")!.target!, CART, "click");
    assert.equal(rulesPick(renamed, { action: "click", call: pay })!.confidence, 0.9);
    // A check of what the page shows is never healed by rules unless the words are the same.
    const shown = parseLocator("getByText('Order confirmed')")!.target!;
    const texts = rankCandidates(shown, CART, "waitFor");
    assert.ok(rulesPick(texts, { action: "waitFor", call: shown })!.confidence < 0.8);
    assert.equal(withExact(parseLocator("getByRole('button', { name: 'Pay' })")!.target!), 'getByRole("button", { name: "Pay", exact: true })');
    // The flow's own style is kept: a label stays a label.
    const form: PageSnapshot = { path: "/login", title: "", elements: flattenAria([{ role: "textbox", name: "E-mail" }, { role: "textbox", name: "Password" }]) };
    const email = rankCandidates(parseLocator("getByLabel('Email')")!.target!, form, "fill");
    assert.deepEqual(email.map((c) => c.code), ['getByLabel("E-mail")', 'getByLabel("Password")']);
    assert.equal(rulesPick(email, { action: "fill", call: parseLocator("getByLabel('Email')")!.target! })!.confidence, 0.8);
  });
});

describe("decider", () => {
  let server: Server;
  let url: string;
  const requests: { path: string; auth?: string; body: Record<string, any> }[] = [];
  let reply: (body: Record<string, any>) => unknown = () => ({});

  before(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text) as Record<string, any>;
      requests.push({ path: req.url!, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply(body)));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const question: Question = {
    kind: "selector",
    ask: "Which element did the flow mean?",
    context: ["logged in with password hunter22 at postgres://u:p@localhost/db"],
    options: { c1: 'button "Place order"', none: "none" },
  };

  it("uses rules when they are sure, Muse Spark when they aren't, and counts the cost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-decider-"));
    const meter = new UsageMeter(dir, "t");
    const decider = new Decider({ levelOne: new MuseSpark(url, "muse-spark-1.3", "meta-key-123"), meter, secrets: ["hunter22"] });
    try {
      assert.deepEqual(
        { ...(await decider.decide(question, { choice: "c1", confidence: 0.9 })), ms: 0 },
        { choice: "c1", confidence: 0.9, by: "rules", ms: 0 },
      );
      assert.equal(requests.length, 0);

      reply = () => ({ choices: [{ message: { content: JSON.stringify({ choice: "c1", confidence: 0.93 }) } }], usage: { prompt_tokens: 400, completion_tokens: 20 } });
      const answer = await decider.decide(question, { choice: "c1", confidence: 0.4 });
      assert.equal(answer.by, "spark");
      assert.equal(answer.choice, "c1");
      const sent = requests.at(-1)!;
      assert.equal(sent.path, "/chat/completions");
      assert.equal(sent.auth, "Bearer meta-key-123");
      assert.equal(sent.body.model, "muse-spark-1.3");
      assert.equal(sent.body.reasoning_effort, "minimal");
      assert.deepEqual(sent.body.response_format.json_schema.schema.properties.choice.enum, ["c1", "none"]);
      const prompt = JSON.stringify(sent.body.messages);
      assert.ok(!prompt.includes("hunter22") && !prompt.includes("postgres://"), "secrets are removed before the question leaves");

      // Unsure: back to the agent, and the spend still counts.
      reply = () => ({ choices: [{ message: { content: JSON.stringify({ choice: "none", confidence: 0.5 }) } }], usage: { prompt_tokens: 400, completion_tokens: 20 } });
      const unsure = await decider.decide(question);
      assert.equal(unsure.by, "agent");
      assert.match(unsure.note!, /unsure/);
      const totals = meter.totals();
      assert.deepEqual(totals.decisions, { rules: 1, spark: 1, jev: 0, agent: 1 });
      assert.equal(Math.round(totals.usd * 1e6), Math.round(2 * (400 * 1.25 + 20 * 4.25)));

      // A spent budget sends decisions to the agent without calling the model.
      const before = requests.length;
      const broke = new Decider({ levelOne: new MuseSpark(url, "m", "k"), meter, budgetUsd: 0.001 });
      assert.match((await broke.decide(question)).note!, /budget/);
      assert.equal(requests.length, before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("asks Jev with a choice question on OpenRouter's Decisions API", async () => {
    reply = () => ({ answers: { decision: { type: "choice", choice: "none", confidence: 0.97, probabilities: { c1: 0.03, none: 0.97 } } }, usage: { input_tokens: 300, output_tokens: 0, cost: 0.00002 } });
    const answer = await new Decider({ levelOne: new Jev(url, "typesafe/jev-1.14", "or-key") }).decide(question);
    assert.equal(answer.by, "jev");
    assert.equal(answer.choice, "none");
    const sent = requests.at(-1)!;
    assert.equal(sent.path, "/decisions");
    assert.deepEqual(sent.body.questions.decision.criteria, question.options);
    assert.equal(sent.body.model, "typesafe/jev-1.14");
  });

  it("hands back with no Level 1 model, and keeps the decision for windtunnel_decide", async () => {
    const answer = await new Decider({}).decide(question, { choice: "c1", confidence: 0.5 });
    assert.equal(answer.by, "agent");
    assert.match(answer.note!, /no Level 1 model/);
    const dir = await mkdtemp(join(tmpdir(), "wt-decisions-"));
    try {
      const store = new DecisionStore(dir);
      const d = await store.add({ question, payload: { kind: "triage" } });
      assert.deepEqual((await store.open()).map((x) => x.id), [d.id]);
      await store.save({ ...d, answered: { at: "now", answer: "c1", result: "ok" } });
      assert.deepEqual(await store.open(), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

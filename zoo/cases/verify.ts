// Verifies the Bug Zoo end to end: every scenario runs against the clean shop and
// every case variant, each run in its own branch (worktree + database copy + app).
//
//   pnpm zoo:verify [--repeat 3] [--case 02-lost-response-retry]
//
// Scenarios are plain Playwright for now; they become experiment files in Phase 2.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Branch, Branches, type CodeVersion, checkRules, loadRules, stopOnSignals } from "@windtunnel/core";
import { chromium, type Page, type Route } from "playwright";
import { parse as parseYaml } from "yaml";

interface Case {
  id: string;
  title: string;
  scenario: string;
  breaks: string[];
  handler: string;
  patch: string;
}

interface Variant {
  id: string;
  version: CodeVersion;
  expected?: Case;
}

interface RunResult {
  variant: string;
  scenario: string;
  broken: string[];
  error?: string;
}

type Scenario = (ctx: { page: Page; branch: Branch }) => Promise<void>;

const ORDER_PAGE = /\/orders\/\d+$/;

const scenarios: Record<string, Scenario> = {
  // Two "Pay now" clicks in a row. Both checkout requests are held until both
  // have arrived, then released together (a lone request is released after 1 s).
  "double-submit": async ({ page, branch }) => {
    const checkout = await holdRequests(page, "**/api/orders", { count: 2, timeoutMs: 1_000 });
    await openCart(page, branch);
    await page.getByRole("button", { name: "Pay now" }).dblclick();
    await page.waitForURL(ORDER_PAGE);
    await checkout.done();
    await page.getByText("Order confirmed").waitFor();
  },

  // The server saves the order, but the browser sees a network error; the user retries.
  "lost-response-retry": async ({ page, branch }) => {
    const tenant = branch.payments!.tenant;
    tenant.configure({ webhooks: "manual" });
    let dropped = false;
    await page.route("**/api/orders", async (route) => {
      const response = await route.fetch();
      if (!dropped) {
        dropped = true;
        return route.abort("failed");
      }
      return route.fulfill({ response });
    });
    await openCart(page, branch);
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.getByText("Network error").waitFor();
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.waitForURL(ORDER_PAGE);
    for (const event of tenant.pending()) await tenant.deliver(event.id);
    await page.getByText("Order confirmed").waitFor();
  },

  // The payment provider delivers the same webhook twice.
  "duplicate-webhook": async ({ page, branch }) => {
    const tenant = branch.payments!.tenant;
    tenant.configure({ webhooks: "manual" });
    await openCart(page, branch);
    await page.getByRole("button", { name: "Pay now" }).click();
    await page.waitForURL(ORDER_PAGE);
    for (const event of tenant.pending()) await tenant.deliver(event.id, 2);
    await page.getByText("Order confirmed").waitFor();
  },
};

/** Logs in as Alice and puts one item in her cart, then opens the cart page. */
async function openCart(page: Page, branch: Branch): Promise<void> {
  const login = await page.request.post(`${branch.baseUrl}/api/session`, {
    data: { email: "alice@example.test", password: "test" },
  });
  if (!login.ok()) throw new Error(`login failed: ${login.status()}`);
  const add = await page.request.post(`${branch.baseUrl}/api/cart/items`, { data: { productId: 1 } });
  if (!add.ok()) throw new Error(`add to cart failed: ${add.status()}`);
  await page.goto(`${branch.baseUrl}/cart`);
}

/**
 * Holds matching requests until `count` have arrived (or `timeoutMs` passed), then
 * sends them to the server at the same moment. done() resolves when every held
 * request has been answered by the server.
 */
async function holdRequests(page: Page, pattern: string, options: { count: number; timeoutMs: number }) {
  const held: Route[] = [];
  const answered: Promise<unknown>[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let timer: NodeJS.Timeout | undefined;

  await page.route(pattern, async (route) => {
    held.push(route);
    if (held.length === 1) timer = setTimeout(release, options.timeoutMs);
    if (held.length >= options.count) release();
    await gate;
    clearTimeout(timer);
    const answer = route.fetch().then((response) => route.fulfill({ response }).catch(() => undefined));
    answered.push(answer);
    await answer.catch(() => undefined);
  });

  return {
    done: async () => {
      await gate;
      await Promise.allSettled(answered);
    },
  };
}

async function loadCases(dir: string, only?: string): Promise<Case[]> {
  const cases: Case[] = [];
  const caseDirs = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^\d{2}-/.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of caseDirs) {
    if (only && name !== only) continue;
    const meta = parseYaml(await readFile(join(dir, name, "case.yaml"), "utf8")) as Omit<Case, "patch">;
    const patch = await readFile(join(dir, name, "bug.patch"), "utf8");
    if (!scenarios[meta.scenario]) throw new Error(`${name}: unknown scenario ${meta.scenario}`);
    cases.push({ ...meta, patch });
  }
  if (only && cases.length === 0) throw new Error(`no case named ${only}`);
  return cases;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { repeat: { type: "string", default: "3" }, case: { type: "string" } },
  });
  const repeat = Number(values.repeat);
  const casesDir = import.meta.dirname;
  const cases = await loadCases(casesDir, values.case);

  const branches = await Branches.open(join(casesDir, "..", "shop"));
  stopOnSignals(() => branches.close());
  const rules = await loadRules(branches.project);

  const variants: Variant[] = [];
  for (const spec of [{ id: "clean" }, ...cases.map((c) => ({ id: c.id, patch: c.patch, expected: c }))]) {
    const started = Date.now();
    const version = await branches.versions.resolve({ patch: "patch" in spec ? spec.patch : undefined, label: spec.id });
    await branches.prepare(version);
    console.log(`prepared ${spec.id.padEnd(24)} version ${version.id}  ${Date.now() - started} ms`);
    variants.push({ id: spec.id, version, expected: "expected" in spec ? spec.expected : undefined });
  }

  const scenarioIds = [...new Set(cases.map((c) => c.scenario))];
  const browser = await chromium.launch();
  const started = Date.now();
  const jobs = variants.flatMap((variant) =>
    scenarioIds.flatMap((scenario) => Array.from({ length: repeat }, () => ({ variant, scenario }))),
  );

  const results = await Promise.all(
    jobs.map(async ({ variant, scenario }): Promise<RunResult> => {
      const branch = await branches.create(variant.version);
      const context = await browser.newContext();
      context.setDefaultTimeout(10_000);
      let error: string | undefined;
      try {
        await scenarios[scenario]!({ page: await context.newPage(), branch });
        await branch.payments?.tenant.settle();
      } catch (err) {
        error = (err as Error).message.split("\n")[0];
      } finally {
        await context.close();
      }
      try {
        const broken = (await checkRules(branch.database.url, rules)).filter((r) => !r.ok).map((r) => r.id);
        return { variant: variant.id, scenario, broken, error };
      } finally {
        await branch.stop();
      }
    }),
  );
  await browser.close();
  await branches.close();

  // Matrix: one row per variant, one column per scenario.
  const failures: string[] = [];
  const width = Math.max(...scenarioIds.map((s) => s.length), 28);
  console.log(`\n${"variant".padEnd(24)} ${scenarioIds.map((s) => s.padEnd(width)).join(" ")}`);
  for (const variant of variants) {
    const cells = scenarioIds.map((scenario) => {
      const runs = results.filter((r) => r.variant === variant.id && r.scenario === scenario);
      const errors = runs.filter((r) => r.error);
      const counts = new Map<string, number>();
      for (const r of runs) for (const id of r.broken) counts.set(id, (counts.get(id) ?? 0) + 1);

      if (variant.id === "clean" && (counts.size > 0 || errors.length > 0)) {
        failures.push(`clean shop: ${scenario} broke ${[...counts.keys()].join(", ") || "nothing"}${errors.length ? `; error: ${errors[0]!.error}` : ""}`);
      }
      if (variant.expected?.scenario === scenario) {
        for (const id of variant.expected.breaks) {
          const n = counts.get(id) ?? 0;
          if (n !== runs.length) failures.push(`${variant.id}: expected ${id} to break in ${runs.length}/${runs.length} runs, got ${n}`);
        }
      }
      const text = counts.size === 0 ? `ok ${runs.length - errors.length}/${runs.length}` : [...counts].map(([id, n]) => `${id} ${n}/${runs.length}`).join(", ");
      return `${text}${errors.length ? ` (${errors.length} err)` : ""}`.padEnd(width);
    });
    console.log(`${variant.id.padEnd(24)} ${cells.join(" ")}`);
  }

  console.log(`\n${results.length} runs in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const r of results.filter((r) => r.error)) console.log(`  error  ${r.variant} / ${r.scenario}: ${r.error}`);
  if (failures.length > 0) {
    console.log(`\nFAIL\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("\nPASS: the clean shop holds every rule; each case breaks its rule in every run.");
  return 0;
}

process.exitCode = await main();

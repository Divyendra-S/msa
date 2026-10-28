// Re-testing only what changed: an experiment's last result is reused while none of the files
// its requests reached (and what they import) changed. Needs git, not Postgres.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ExperimentResult, experimentInputs, loadExperiments, loadRules, Runner } from "@windtunnel/core";
import { findAffected } from "../src/affected.ts";

const FILES: Record<string, string> = {
  "package.json": `{ "name": "app", "dependencies": { "next": "16.0.0" } }`,
  "windtunnel.config.yaml": `app:\n  start: next start\ndb:\n  kind: postgres\n  url: postgres://x@127.0.0.1:1/x\n  seed: node scripts/seed.mjs\n`,
  "scripts/seed.mjs": `console.log("seed");\n`,
  "README.md": "# app\n",
  "lib/db.ts": `export const query = async (sql: string) => sql;\n`,
  "lib/cart.ts": `import { query } from "./db";\nexport const cart = () => query("SELECT 1");\n`,
  "app/layout.tsx": `export default function Layout({ children }: { children: unknown }) { return children; }\n`,
  "app/page.tsx": `import { Header } from "../components/Header";\nexport default function Page() { return <Header />; }\n`,
  "components/Header.tsx": `export function Header() { return <h1>Shop</h1>; }\n`,
  "app/api/orders/route.ts": `import { cart } from "@/lib/cart";\nexport async function POST() { return Response.json(await cart()); }\n`,
  "app/api/products/[id]/route.ts": `import { query } from "../../../../lib/db";\nexport async function GET() { return Response.json(await query("SELECT 2")); }\n`,
  "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./*"] } } }`,
  ".windtunnel/flows/a.ts": `import { flow } from "windtunnel";\nexport default flow(async () => {});\n`,
  ".windtunnel/flows/b.ts": `import { flow } from "windtunnel";\nexport default flow(async () => {});\n`,
  ".windtunnel/experiments/checkout.yaml": `flow: a\n`,
  ".windtunnel/experiments/product.yaml": `flow: b\n`,
  ".windtunnel/rules.yaml": `no-rows:\n  sql: SELECT 1 WHERE false\n`,
};

describe("affected experiments", () => {
  let root: string;
  let runner: Runner;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "wt-affected-")));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    runner = await Runner.open(root);

    // Last results as a run would record them: what each experiment's requests reached.
    const version = await runner.branches.versions.resolve({});
    const rules = await loadRules(runner.project);
    const touched: Record<string, string[]> = { checkout: ["GET /", "POST /api/orders"], product: ["GET /api/products/7"] };
    for (const experiment of await loadExperiments(runner.project)) {
      const { id, dir } = await runner.store.create();
      const result: ExperimentResult = {
        runId: id,
        experiment: experiment.id,
        version: { id: version.id, label: "working tree", tree: version.tree },
        outcome: "pass",
        variants: [{ variant: "default", runs: 3, ok: 3, broken: 0, errors: 0, outcome: "pass", flakeRate: 0, rules: {} }],
        reps: [],
        startedAt: new Date().toISOString(),
        durationMs: 1,
        dir,
        inputs: await experimentInputs(runner.project, experiment, rules),
        touched: touched[experiment.id],
      };
      await runner.store.finish(dir, result, { id, experiment: experiment.id, version: version.id, startedAt: result.startedAt, outcome: "pass", headline: "pass" });
    }
  });

  after(async () => {
    await runner?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const statuses = async () =>
    Object.fromEntries((await findAffected(runner, await loadExperiments(runner.project), { repeat: 1 })).map((s) => [s.experiment, `${s.status}: ${s.reason}`]));
  const edit = async (path: string, text = "\n// edited\n") => appendFile(join(root, path), text);
  const reset = () => {
    git("checkout", "-q", "--", ".");
    git("clean", "-qfd", "--", "app", "lib", "scripts");
  };

  it("reuses every result while the code is the same", async () => {
    const s = await statuses();
    assert.match(s.checkout!, /^cached: same code/);
    assert.match(s.product!, /^cached: same code/);
  });

  it("re-runs only the experiments whose handlers (or what they import) changed", async () => {
    await edit("lib/cart.ts");
    let s = await statuses();
    assert.match(s.checkout!, /^affected: changed since .*: lib\/cart\.ts/);
    assert.match(s.product!, /^cached: none of its \d+ files changed/);
    reset();

    await edit("lib/db.ts");
    s = await statuses();
    assert.match(s.checkout!, /^affected: .*lib\/db\.ts/);
    assert.match(s.product!, /^affected: .*lib\/db\.ts/);
    reset();

    // A page's components and layouts count for the experiments that loaded the page.
    await edit("components/Header.tsx");
    s = await statuses();
    assert.match(s.checkout!, /^affected: .*components\/Header\.tsx/);
    assert.match(s.product!, /^cached/);
    reset();
  });

  it("re-runs everything when something other than app code changes, but not for docs", async () => {
    await edit("scripts/seed.mjs");
    let s = await statuses();
    assert.match(s.checkout!, /^affected: .*scripts\/seed\.mjs/);
    assert.match(s.product!, /^affected: .*scripts\/seed\.mjs/);
    reset();

    // A new route matters only to the experiments whose requests it now handles.
    await mkdir(join(root, "app/api/products/new"), { recursive: true });
    await writeFile(join(root, "app/api/products/new/route.ts"), "export async function GET() { return Response.json(1); }\n");
    s = await statuses();
    assert.match(s.product!, /^cached/);
    await mkdir(join(root, "app/api/products/7"), { recursive: true });
    await writeFile(join(root, "app/api/products/7/route.ts"), "export async function GET() { return Response.json(7); }\n");
    s = await statuses();
    assert.match(s.product!, /^affected: .*app\/api\/products\/7\/route\.ts/);
    assert.match(s.checkout!, /^cached/);
    reset();

    // A removed route may have handled any request: everything runs again.
    await rm(join(root, "app/api/orders/route.ts"));
    s = await statuses();
    assert.match(s.product!, /^affected: .*app\/api\/orders\/route\.ts \(route removed\)/);
    reset();

    await edit("README.md", "more docs\n");
    s = await statuses();
    assert.match(s.checkout!, /^cached/);
    assert.match(s.product!, /^cached/);
    reset();
  });

  it("treats an experiment, flow or rule edit as a new experiment", async () => {
    await edit(".windtunnel/flows/b.ts");
    const s = await statuses();
    assert.match(s.checkout!, /^cached/);
    assert.match(s.product!, /^new: no finished run with this experiment, flow and rules/);
    reset();
  });
});

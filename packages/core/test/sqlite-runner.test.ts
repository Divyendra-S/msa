// A whole run of an app on SQLite, with no Postgres: a data folder and a database copy per run,
// HOME pointed at the folder, SQL and check rules, the database diff, and the HTTP proxy seam.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { clean } from "../src/cleanup.ts";
import type { DbDiff } from "../src/runner/db-diff.ts";
import { loadExperiments } from "../src/runner/experiment.ts";
import type { RequestRecord } from "../src/runner/network.ts";
import { type ExperimentResult, Runner } from "../src/runner/runner.ts";

// Each send adds a row and writes a receipt named after the user, so a second send overwrites
// the first one's receipt. With no DATABASE_PATH it keeps its rows in memory.
const SERVER = `const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const db = process.env.DATABASE_PATH ? new DatabaseSync(process.env.DATABASE_PATH) : undefined;
const memory = [];
fs.writeFileSync(path.join(process.env.HOME, "started"), String(process.pid));
const page = (body) => "<!doctype html><html><body>" + body + "</body></html>";
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.setHeader("content-type", "text/html");
    return res.end(page('<button id="send">Send</button><p id="status"></p><script>' +
      'document.getElementById("send").onclick = async () => { const s = document.getElementById("status");' +
      'try { const r = await fetch("/api/send", { method: "POST" }); s.textContent = r.ok ? "Sent " + (await r.json()).id : "Failed " + r.status; }' +
      'catch { s.textContent = "Network error"; } };</script>'));
  }
  if (req.method === "POST" && req.url === "/api/send") {
    return setTimeout(() => {
      const id = db ? Number(db.prepare("INSERT INTO hits (who) VALUES ('alice')").run().lastInsertRowid) : memory.push("alice");
      fs.mkdirSync(path.join(process.env.DATA_DIR, "receipts"), { recursive: true });
      fs.writeFileSync(path.join(process.env.DATA_DIR, "receipts", "alice.txt"), String(id));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id }));
    }, 30);
  }
  res.writeHead(404);
  res.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

const SEED = `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL; CREATE TABLE hits (id INTEGER PRIMARY KEY, who TEXT NOT NULL); INSERT INTO hits (who) VALUES ('seed')");
`;

// Prints a row for every hit whose receipt is missing, and one if the app's HOME wasn't the run's folder.
const CHECK = `const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
if (!fs.existsSync(path.join(process.env.DATA_DIR, "started"))) console.log(JSON.stringify({ problem: "the app's HOME was not the run's data folder" }));
const receipts = new Set(fs.readdirSync(path.join(process.env.DATA_DIR, "receipts"), { withFileTypes: true }).map((f) => fs.readFileSync(path.join(process.env.DATA_DIR, "receipts", f.name), "utf8")));
const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
for (const hit of db.prepare("SELECT id FROM hits WHERE who <> 'seed'").all()) if (!receipts.has(String(hit.id))) console.log(JSON.stringify({ hit: hit.id }));
`;

const FLOW = `import { flow } from "windtunnel";

export default flow(async ({ page, step }) => {
  await step("open", () => page.goto("/"));
  await step("send", () => page.getByRole("button", { name: "Send" }).click());
  await step("result", () => page.getByText(/^Sent \\d+$/).waitFor());
});
`;

const EXPERIMENTS: Record<string, string> = {
  plain: "flow: send",
  "double-submit": "flow: send\nperturb: [{ do: double-submit, step: send }]",
  "lost-response": "flow: send\nperturb:\n  - { do: lose-response, request: POST /api/send, step: send }\n  - { do: repeat, step: send }",
};

async function createRepo(files: Record<string, string>): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "wt-sqlite-")));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "t");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return repo;
}

function experimentFiles(): Record<string, string> {
  return Object.fromEntries(Object.entries(EXPERIMENTS).map(([id, text]) => [`.windtunnel/experiments/${id}.yaml`, `${text}\nrepeat: 1\n`]));
}

describe("an app on SQLite, without Postgres", () => {
  let repo: string;
  let cache: string;
  let runner: Runner;
  const route = new Map<string, ExperimentResult>();
  const proxied = new Map<string, ExperimentResult>();

  before(async () => {
    repo = await createRepo({
      "server.cjs": SERVER,
      "seed.cjs": SEED,
      "checks/receipts.cjs": CHECK,
      "windtunnel.config.yaml": "app:\n  start: node server.cjs\n  isolateHome: true\ndb:\n  kind: sqlite\n  file: db/app.db\n  seed: node seed.cjs\nparallel: 3\n",
      ".windtunnel/rules.yaml": `at-most-one-hit:
  sql: SELECT count(*) AS hits FROM hits HAVING count(*) - (SELECT count(*) FROM windtunnel_seed.hits) > 1
every-hit-has-its-receipt:
  check: node checks/receipts.cjs
`,
      ".windtunnel/flows/send.ts": FLOW,
      ...experimentFiles(),
    });
    cache = await mkdtemp(join(tmpdir(), "wt-cache-"));
    process.env.WINDTUNNEL_CACHE_DIR = cache;
    runner = await Runner.open(repo);
    assert.equal(runner.branches.pg, undefined);
    const experiments = await loadExperiments(runner.project);
    for (const r of await runner.run(experiments)) route.set(r.experiment, r);
    for (const r of await runner.run(experiments, { seam: "proxy" })) proxied.set(r.experiment, r);
  });

  after(async () => {
    await clean(runner.branches, { all: true }).catch(() => undefined);
    await runner?.close();
    if (!process.env.WT_KEEP) await rm(repo, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  const rep = async <T>(result: ExperimentResult, file: string) =>
    JSON.parse(await readFile(join(result.dir, "reps", "1", file), "utf8")) as T;

  it("gives each run its own copy of the seeded SQLite file and data folder", async () => {
    const plain = route.get("plain")!;
    assert.equal(plain.outcome, "pass", plain.variants[0]?.firstError?.message);
    assert.equal(plain.reps[0]!.diff, "hits +1");
    const diff = await rep<DbDiff>(plain, "db-diff.json");
    assert.deepEqual(diff.tables.hits?.added, [{ id: 2, who: "alice" }]);
    const result = await rep<{ branch: { database: string; dataDir: string } }>(plain, "result.json");
    assert.equal(result.branch.database, join(result.branch.dataDir, "db", "app.db"));
  });

  it("SQL and check rules break when the receipt is overwritten", async () => {
    const double = route.get("double-submit")!;
    assert.equal(double.outcome, "fail");
    assert.deepEqual(double.reps[0]!.broken.sort(), ["at-most-one-hit", "every-hit-has-its-receipt"]);
    const { rules } = await rep<{ rules: { id: string; rows: unknown[] }[] }>(double, "result.json");
    assert.deepEqual(rules.find((r) => r.id === "every-hit-has-its-receipt")!.rows.length, 1);
  });

  it("gives the same verdicts through the HTTP proxy", async () => {
    for (const id of Object.keys(EXPERIMENTS)) {
      const a = route.get(id)!;
      const b = proxied.get(id)!;
      assert.equal(b.outcome, a.outcome, `${id}: ${b.variants[0]?.firstError?.message ?? ""}`);
      assert.deepEqual(b.reps[0]!.broken.sort(), a.reps[0]!.broken.sort(), id);
    }
    const sends = (await rep<RequestRecord[]>(proxied.get("lost-response")!, "requests.json")).filter((r) => r.url === "/api/send");
    assert.equal(sends.length, 2, "the browser didn't retry the lost call on its own");
    assert.equal(sends[0]!.failure, "connection reset by the harness");
    assert.equal(sends[0]!.tab, "guest");
    const result = await rep<{ branch: { seam?: string }; steps: { shot?: string }[] }>(proxied.get("plain")!, "result.json");
    assert.equal(result.branch.seam, "proxy");
    assert.ok(result.steps.every((s) => s.shot), "every step has its screenshot");
  });
});

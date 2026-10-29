// Runs the shop on this machine: a fresh database with the seed data, the mock payment provider
// and the app (built first). Prints "ready: <url>" once the shop answers; Ctrl-C stops everything.
//
//   node scripts/local.mjs [--port 3001] [--database shop_local_3001] [--no-build] [--keep-db]   (--port defaults to $PORT, else 3001)
//   node scripts/local.mjs --exec "node check.mjs"   start, run one command against the shop, stop
//
// --exec runs the command with BASE_URL, DATABASE_URL and PAYMENT_API_URL set and exits with its
// exit code. Postgres: $ADMIN_DATABASE_URL (default postgres://postgres:postgres@127.0.0.1:55432/postgres).
// Payments: `mock-pay` on PATH, or ../mock-pay in the Bug Zoo repository.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.PORT ?? "3001" },
    database: { type: "string" },
    "no-build": { type: "boolean", default: false },
    "keep-db": { type: "boolean", default: false },
    exec: { type: "string" },
  },
});
const port = Number(values.port);
const payPort = port + 1000;
const database = values.database ?? `shop_local_${port}`;
if (!/^\w+$/.test(database)) throw new Error(`bad database name: ${database}`);
const admin = process.env.ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:55432/postgres";
const databaseUrl = Object.assign(new URL(admin), { pathname: `/${database}` }).href;
const secret = "whsec_local";
const children = [];

function run(command, args, env = {}, inherit = true) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function exited(child) {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
}

async function adminQuery(sql) {
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

let stopping = false;
async function stop(code) {
  // Stopping ends the app too, which would call this again with its own exit code.
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  if (!values["keep-db"]) await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  process.exit(code);
}
process.on("SIGINT", () => void stop(130));
process.on("SIGTERM", () => void stop(143));

await adminQuery(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
await adminQuery(`CREATE DATABASE ${database}`);
if ((await exited(run(process.execPath, ["scripts/db-setup.mjs"], { DATABASE_URL: databaseUrl }))) !== 0) await stop(1);

const sibling = join(root, "..", "mock-pay", "src", "bin.ts");
const payArgs = ["--port", String(payPort), "--webhook-url", `http://127.0.0.1:${port}/api/webhooks/payment`, "--secret", secret];
run(existsSync(sibling) ? process.execPath : "mock-pay", existsSync(sibling) ? [sibling, ...payArgs] : payArgs).once("error", () => {
  console.error("mock-pay not found: put it on PATH");
  void stop(1);
});

const next = join(root, "node_modules", ".bin", "next");
if (!values["no-build"] && (await exited(run(next, ["build"]))) !== 0) await stop(1);
const env = { DATABASE_URL: databaseUrl, PAYMENT_API_URL: `http://127.0.0.1:${payPort}`, PAYMENT_WEBHOOK_SECRET: secret };
const app = run(next, ["start", "--port", String(port)], env, !values.exec);
void exited(app).then((code) => stop(code));

const baseUrl = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  const ok = await fetch(`${baseUrl}/api/health`).then((r) => r.ok, () => false);
  if (ok) break;
  if (i > 300) {
    console.error("the shop did not answer within 60 s");
    await stop(1);
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`ready: ${baseUrl}  (database ${database}, payments http://127.0.0.1:${payPort})`);

if (values.exec) {
  const command = spawn(values.exec, { cwd: process.cwd(), shell: true, stdio: "inherit", env: { ...process.env, ...env, BASE_URL: baseUrl } });
  await stop(await exited(command));
}

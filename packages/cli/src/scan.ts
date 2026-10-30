import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CONFIG_FILE, openProject, type Project } from "@windtunnel/core";
import { buildAppMap, formatEffects } from "@windtunnel/explorer";

/** One handler and what in its code is worth an experiment. */
export interface ScanRoute {
  method: string;
  path: string;
  file: string;
  comment?: string;
  /** What it does, in order: `auth:getCurrentUser · tx{ … } · fetch POST /v1/charges`. */
  does: string;
  /** The patterns found, each with what could go wrong, in plain words. */
  risks: { flag: string; says: string }[];
  /** Guards seen, e.g. webhook dedupe. */
  guards: string[];
}

export interface ScanResult {
  root: string;
  framework: string;
  routes: ScanRoute[];
  pages: number;
  /** Patterns in shared helpers, e.g. sessions that never expire. */
  helpers: { flag: string; says: string }[];
}

/**
 * `windtunnel scan`: the static half of the app map for any Next.js or Tauri folder, no config needed and
 * no model, build or database involved. The Mac app shows it as soon as a folder is picked, before
 * anything is set up.
 */
export async function scan(dir: string): Promise<ScanResult> {
  // A folder set up for Wind Tunnel says where its server is (a phone app's is in `app.dir`).
  const configured = (await stat(join(resolve(dir), CONFIG_FILE)).then(() => true, () => false))
    ? await openProject(resolve(dir)).catch(() => undefined)
    : undefined;
  const root = configured?.root ?? (await nextApp(resolve(dir)));
  // The map reads only the source tree; the project's other parts are for runs.
  const project = configured ?? ({ root, repoRoot: root, appSubdir: "", stateDir: join(root, ".windtunnel"), config: { users: {} } } as unknown as Project);
  const map = await buildAppMap(project);
  return {
    root,
    framework: map.framework,
    routes: map.routes.map((r) => ({
      method: r.method,
      path: r.path,
      file: r.file,
      ...(r.comment ? { comment: r.comment } : {}),
      does: formatEffects(r.effects, 400),
      risks: r.flags.map((flag) => ({ flag, says: plain(flag) })),
      guards: r.notes,
    })),
    pages: map.pages.filter((p) => p.kind === "page").length,
    helpers: map.helperFlags.map((flag) => ({ flag, says: plain(flag) })),
  };
}

export function formatScan(s: ScanResult): string {
  const risky = s.routes.filter((r) => r.risks.length);
  const lines = [`${s.framework} · ${s.root}`, `${s.routes.length} handlers, ${s.pages} pages; ${risky.length} worth a look`, ""];
  for (const r of risky) {
    lines.push(`${r.method} ${r.path || "(server action)"}  ${r.file}`);
    for (const risk of r.risks) lines.push(`  ! ${risk.says}`);
    for (const g of r.guards) lines.push(`  ✓ ${g}`);
  }
  for (const h of s.helpers) lines.push(`! ${h.says}`);
  return lines.join("\n");
}

/** What a pattern the map flags can do to the data, in a sentence. Names from the code are in backticks. */
export function plain(flag: string): string {
  let m: RegExpExecArray | null;
  const list = (names: string) => names.split(/,\s*/).map((n) => `\`${n}\``).join(", ");
  if ((m = /^check-then-act on (\S+): read, then (\w+)/.exec(flag))) {
    return `Reads \`${m[1]}\`, then writes it without checking again: two requests at once can both pass the check.`;
  }
  if ((m = /^blind (UPDATE|DELETE) (\S+).*?( after an external call)?$/.exec(flag))) {
    const verb = m[1] === "DELETE" ? "Deletes from" : "Updates";
    return m[3]
      ? `${verb} \`${m[2]}\` after calling out, whatever state it's in: a late or repeated request overwrites what's there.`
      : `${verb} \`${m[2]}\` whatever state it's in: a late or repeated request overwrites what's there.`;
  }
  if ((m = /^(INSERT|UPDATE|DELETE) (\S+) after an external call/.exec(flag))) {
    return `Writes \`${m[2]}\` after calling another service: if that answer is lost and the user retries, it runs twice.`;
  }
  if ((m = /^INSERT (\S+): no ON CONFLICT/.exec(flag))) {
    return `Adds a row to \`${m[1]}\` each time with nothing to stop a duplicate: a repeated request adds a second one.`;
  }
  if ((m = /^reads (.+) before tx\{/.exec(flag))) {
    return `Reads ${list(m[1]!)} before its transaction starts: another request can change it in between.`;
  }
  if ((m = /^(\d+) writes outside a transaction \((.+)\)/.exec(flag))) {
    return `Writes ${list(m[2]!)} outside a transaction: a failure halfway leaves part of the change behind.`;
  }
  if ((m = /^external (\w+) (\S+)/.exec(flag))) {
    return `Calls \`${m[2]}\` with no idempotency key: a retry can charge or send twice.`;
  }
  if ((m = /^upsert (\S+): writes the row whether or not it still exists/.exec(flag))) {
    return `Writes \`${m[1]}\` with an upsert: a late call can bring back a row that was deleted in the meantime.`;
  }
  if (flag.startsWith("no auth or signature check")) return "Changes data with no login or signature check.";
  if ((m = /^\w+ (\S+) by .* with no owner/.exec(flag))) {
    return `Looks up \`${m[1]}\` by its id alone: another signed-in user may be able to reach it.`;
  }
  if (flag.startsWith("webhook with no event-id dedupe")) {
    return "Doesn't remember webhooks it has handled: providers send them more than once, and early.";
  }
  if (/session lookup with no expiry check/.test(flag)) return "Looks up sessions without checking they've expired.";
  return flag;
}

/** The app in `dir`: the folder itself, or the one below it (two levels at most) with a Next.js app, else a Tauri app. */
async function nextApp(dir: string): Promise<string> {
  const hasNext = async (d: string) => {
    const pkg = JSON.parse((await readFile(join(d, "package.json"), "utf8").catch(() => "{}")) || "{}") as Record<string, Record<string, string> | undefined>;
    return !!(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  };
  const hasTauri = (d: string) => readFile(join(d, "src-tauri", "tauri.conf.json")).then(() => true, () => false);
  for (const has of [hasNext, hasTauri]) {
    if (await has(dir)) return dir;
    for (const a of await subdirs(dir)) {
      if (await has(a)) return a;
      for (const b of await subdirs(a)) if (await has(b)) return b;
    }
  }
  return dir;
}

async function subdirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => join(dir, e.name)).sort();
}

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DIST_DIR } from "./server.ts";

const PACKAGE_DIR = join(DIST_DIR, "..");
const APP_DIR = join(PACKAGE_DIR, "app");

/** ok: dist/ is up to date · stale: app/ changed since the last build · missing: never built. */
export async function uiStatus(): Promise<"ok" | "stale" | "missing"> {
  const built = await stat(join(DIST_DIR, "index.html")).catch(() => undefined);
  if (!built) return "missing";
  // A published package has dist/ and no app/: nothing to compare with.
  const sources = await newest(APP_DIR);
  const config = (await stat(join(PACKAGE_DIR, "vite.config.ts")).catch(() => undefined))?.mtimeMs ?? 0;
  return Math.max(sources, config) > built.mtimeMs ? "stale" : "ok";
}

/** Builds app/ into dist/ with Vite (a dev dependency: present in a checkout of the repository). */
export async function buildUi(): Promise<void> {
  const vite = await import("vite").catch(() => {
    throw new Error("the viewer's UI isn't built and Vite isn't installed: run pnpm install, then pnpm viewer:build");
  });
  await vite.build({ configFile: join(PACKAGE_DIR, "vite.config.ts"), root: APP_DIR, logLevel: "warn" });
}

async function newest(dir: string): Promise<number> {
  let latest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? await newest(path) : ((await stat(path).catch(() => undefined))?.mtimeMs ?? 0));
  }
  return latest;
}

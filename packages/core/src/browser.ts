import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

/** The Chromium build this Playwright version drives, and whether it has been downloaded. */
export function chromiumStatus(): { path: string; installed: boolean } {
  const path = chromium.executablePath();
  return { path, installed: existsSync(path) };
}

/** Playwright's own CLI, for `install chromium` with the version Wind Tunnel uses. */
export function playwrightCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
}

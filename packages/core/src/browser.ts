import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type BrowserType, chromium, webkit } from "playwright";
import type { AppKind } from "./config.ts";

/**
 * The browser a run drives the app's pages in: Chromium for web apps; WebKit for Tauri apps,
 * whose pages run in WebKit's web view on macOS and Linux.
 */
export function browserFor(kind: AppKind): { name: "chromium" | "webkit"; type: BrowserType } {
  return kind === "tauri" ? { name: "webkit", type: webkit } : { name: "chromium", type: chromium };
}

/** The Chromium build this Playwright version drives, and whether it has been downloaded. */
export function chromiumStatus(): { path: string; installed: boolean } {
  return browserStatus("web");
}

/** The browser build a kind of app needs, and whether it has been downloaded. */
export function browserStatus(kind: AppKind): { name: string; path: string; installed: boolean } {
  const { name, type } = browserFor(kind);
  const path = type.executablePath();
  return { name, path, installed: existsSync(path) };
}

/** Playwright's own CLI, for `install chromium` (or `webkit`) with the version Wind Tunnel uses. */
export function playwrightCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve("playwright/package.json")), "cli.js");
}

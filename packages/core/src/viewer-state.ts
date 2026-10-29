import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Where a running viewer leaves its address: `.windtunnel/cache/viewer.json` (git-ignored, outside what `clean` stops). */
export const VIEWER_FILE = join("cache", "viewer.json");

export interface ViewerState {
  /** `http://127.0.0.1:4477` */
  url: string;
  port: number;
  pid: number;
  /** Opens the viewer in a new browser: `<url>/?token=…` sets its cookie. */
  token: string;
  startedAt: string;
}

/** The viewer serving this project, if one is running. */
export async function runningViewer(stateDir: string): Promise<ViewerState | undefined> {
  const text = await readFile(join(stateDir, VIEWER_FILE), "utf8").catch(() => undefined);
  if (!text) return undefined;
  const state = JSON.parse(text) as ViewerState;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    return undefined;
  }
}

/**
 * A link to a page of the running viewer (`/run/<id>`), without the token: it opens in a browser
 * that already has the viewer open, and is safe to show a model.
 */
export async function viewerLink(stateDir: string, route: string): Promise<string | undefined> {
  const viewer = await runningViewer(stateDir);
  return viewer ? `${viewer.url}/#${route}` : undefined;
}

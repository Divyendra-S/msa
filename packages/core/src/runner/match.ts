/**
 * Request patterns in experiment files: `"POST /api/orders"`, `"GET /api/orders/:id"`,
 * `"* /api/**"`. The query string is ignored; `*` matches one path segment, `**` any number.
 * A Tauri app's command calls are `"invoke save_note"` (`*` matches any part of a name).
 */
export interface RequestPattern {
  text: string;
  method: string;
  path: RegExp;
}

export const REQUEST_PATTERN = /^(?:(\*|[A-Za-z]+)\s+(\/\S*)|invoke\s+([^\s/]+))$/i;

/** Where a Tauri page's `invoke` calls go (crates/windtunnel-tauri): `POST /__windtunnel/invoke/<command>`. */
export const INVOKE_PATH = "/__windtunnel/invoke/";

export function parseRequestPattern(text: string): RequestPattern {
  const m = REQUEST_PATTERN.exec(text.trim());
  if (!m) throw new Error(`bad request pattern "${text}": expected "METHOD /path", e.g. "POST /api/orders", or "invoke <command>"`);
  if (m[3]) {
    const command = m[3].split("*").map((part) => escapeRegExp(encodeURIComponent(part))).join("[^/]*");
    return { text: text.trim(), method: "POST", path: new RegExp(`^${escapeRegExp(INVOKE_PATH)}${command}$`) };
  }
  const source = m[2]!
    .replace(/\/+$/, "")
    .split("/")
    .map((segment) => {
      if (segment === "**") return ".*";
      if (/^:[A-Za-z_]\w*$/.test(segment)) return "[^/]+";
      return segment.split("*").map(escapeRegExp).join("[^/]*");
    })
    .join("/");
  return { text: text.trim(), method: m[1]!.toUpperCase(), path: new RegExp(`^${source}/?$`) };
}

export function matchesRequest(pattern: RequestPattern, method: string, url: string | URL): boolean {
  if (pattern.method !== "*" && pattern.method !== method.toUpperCase()) return false;
  return pattern.path.test(new URL(url).pathname);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
export const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

/** `250`, `"250ms"`, `"3s"`, `"25h"` → milliseconds. */
export function parseDuration(value: number | string): number {
  if (typeof value === "number") return value;
  const m = DURATION.exec(value.trim());
  if (!m) throw new Error(`bad duration "${value}": use a number of ms or e.g. "500ms", "3s", "25h"`);
  return Math.round(Number(m[1]) * UNITS[m[2]!]!);
}

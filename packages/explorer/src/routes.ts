import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface RouteFile {
  /** `app` (App Router route handler), `pages-api`, `page`, `layout` or `action` ("use server" module). */
  kind: "app" | "pages-api" | "page" | "layout" | "action";
  /** URL pattern with `:param` and `**` (catch-all); empty for actions. */
  path: string;
  file: string;
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".windtunnel", "dist", "build", "out", "coverage", "public"]);
const SOURCE = /\.(tsx?|jsx?|mjs)$/;

/** Next.js routes (App Router and Pages Router) and "use server" modules under `root`. */
export async function findNextRoutes(root: string): Promise<{ framework: string; routes: RouteFile[] }> {
  const routes: RouteFile[] = [];
  let framework = "unknown";
  const pkg = JSON.parse((await readFile(join(root, "package.json"), "utf8").catch(() => "{}")) || "{}") as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) framework = `Next.js ${deps.next.replace(/^[^\d]*/, "")}`;

  for (const appDir of ["app", join("src", "app")]) {
    for (const file of await walk(join(root, appDir))) {
      const rel = relative(join(root, appDir), file);
      const parts = rel.split(sep);
      const base = parts.pop()!.replace(SOURCE, "");
      if (!["route", "page", "layout"].includes(base)) continue;
      const path = appPath(parts);
      if (path === undefined) continue;
      routes.push({ kind: base === "route" ? "app" : (base as "page" | "layout"), path, file });
    }
  }
  for (const pagesDir of ["pages", join("src", "pages")]) {
    for (const file of await walk(join(root, pagesDir))) {
      const parts = relative(join(root, pagesDir), file).split(sep);
      const base = parts.pop()!.replace(SOURCE, "");
      if (base.startsWith("_")) continue;
      const segments = [...parts, ...(base === "index" ? [] : [base])];
      const path = appPath(segments) ?? "/";
      routes.push({ kind: parts[0] === "api" ? "pages-api" : "page", path, file });
    }
  }
  for (const file of await walk(root)) {
    if (routes.some((r) => r.file === file)) continue;
    const head = (await readFile(file, "utf8").catch(() => "")).slice(0, 200);
    if (/^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']/.test(head)) routes.push({ kind: "action", path: "", file });
  }
  return { framework, routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind)) };
}

/** `["orders", "[id]"]` → `/orders/:id`; route groups and parallel slots drop out. */
function appPath(segments: string[]): string | undefined {
  const out: string[] = [];
  for (const seg of segments) {
    if (/^\(.*\)$/.test(seg) || seg.startsWith("@")) continue;
    if (/^\(\.+\)/.test(seg)) return undefined; // intercepting routes
    const catchAll = /^\[\[?\.\.\.(\w+)\]\]?$/.exec(seg);
    if (catchAll) out.push("**");
    else out.push(seg.replace(/^\[(\w+)\]$/, ":$1"));
  }
  return `/${out.join("/")}`;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) files.push(...(await walk(join(dir, entry.name))));
    } else if (SOURCE.test(entry.name) && !/\.(test|spec|d)\.[jt]sx?$/.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

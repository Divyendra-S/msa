import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const SHOP_DIR = join(REPO_ROOT, "zoo", "shop");
export const CASES_DIR = join(REPO_ROOT, "zoo", "cases");
/** Shop paths in case patches start with this (`a/zoo/shop/app/…`): strip 3 components inside a trial. */
export const PATCH_STRIP = 3;

/** One Bug Zoo variant: a seeded bug, or a clean control whose code only looks risky. */
export interface ZooCase {
  id: string;
  title: string;
  summary: string;
  control: boolean;
  /** The experiment that breaks with the bug (bugs only). */
  experiment?: string;
  variant?: string;
  breaks: string[];
  /** The file with the bug (bugs only). */
  handler?: string;
  /** The seeded case a control imitates. */
  looksLike?: string;
  /** `bug.patch` or `control.patch`. */
  patchFile: string;
  patch: string;
}

/** Every case in `zoo/cases`, bugs first; `select` keeps `all`, `bugs`, `controls` or ids and id prefixes (`05`, `c1`). */
export async function loadCases(select: string[] = ["all"]): Promise<ZooCase[]> {
  const dirs = (await readdir(CASES_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^(\d{2}|c\d)-/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.startsWith("c")) - Number(b.startsWith("c")) || a.localeCompare(b));
  const cases: ZooCase[] = [];
  for (const name of dirs) {
    const meta = parseYaml(await readFile(join(CASES_DIR, name, "case.yaml"), "utf8")) as Record<string, any>;
    const control = meta.control === true;
    const patchFile = join(CASES_DIR, name, control ? "control.patch" : "bug.patch");
    cases.push({
      id: name,
      title: String(meta.title ?? name),
      summary: String(meta.summary ?? ""),
      control,
      ...(meta.experiment ? { experiment: String(meta.experiment) } : {}),
      ...(meta.variant ? { variant: String(meta.variant) } : {}),
      breaks: (meta.breaks as string[] | undefined) ?? [],
      ...(meta.handler ? { handler: String(meta.handler) } : {}),
      ...(meta["looks-like"] ? { looksLike: String(meta["looks-like"]) } : {}),
      patchFile,
      patch: await readFile(patchFile, "utf8"),
    });
  }
  const wanted = select.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0 || wanted.includes("all")) return cases;
  const picked = cases.filter(
    (c) =>
      (wanted.includes("bugs") && !c.control) ||
      (wanted.includes("controls") && c.control) ||
      wanted.some((w) => c.id === w || c.id.startsWith(`${w}-`)),
  );
  const unknown = wanted.filter((w) => !["bugs", "controls"].includes(w) && !cases.some((c) => c.id === w || c.id.startsWith(`${w}-`)));
  if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(", ")} (known: ${cases.map((c) => c.id).join(", ")})`);
  return picked;
}

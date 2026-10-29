import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** True when running from the repository's TypeScript sources, false in the published package. */
export const FROM_SOURCE = import.meta.filename.endsWith(".ts");

/** The repository, or the published package's folder (its code is in dist/). */
export const PACKAGE_ROOT = FROM_SOURCE ? join(import.meta.dirname, "..", "..", "..") : dirname(import.meta.dirname);

/** The agent plugin: plugins/windtunnel in the repository, plugin/ in the package. */
export const PLUGIN_DIR = FROM_SOURCE ? join(PACKAGE_ROOT, "plugins", "windtunnel") : join(PACKAGE_ROOT, "plugin");

/** Copies the skills (init, hunt, prove, test) into `out`, each named `<prefix><name>`. */
export async function writeSkills(out: string, prefix = ""): Promise<string[]> {
  const skillsDir = join(PLUGIN_DIR, "skills");
  const written: string[] = [];
  for (const name of (await readdir(skillsDir)).sort()) {
    const target = join(resolve(out), `${prefix}${name}`);
    await mkdir(target, { recursive: true });
    await cp(join(skillsDir, name), target, { recursive: true });
    const skill = join(target, "SKILL.md");
    const text = await readFile(skill, "utf8");
    // The skill's own name and references to sibling skills get the prefix too.
    await writeFile(skill, text.replace(/^name: (.+)$/m, `name: ${prefix}$1`).replace(/\b(init|hunt|prove|test) skill\b/g, `${prefix}$1 skill`));
    written.push(target);
  }
  return written;
}

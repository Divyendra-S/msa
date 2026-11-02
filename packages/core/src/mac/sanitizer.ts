import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runScript } from "../exec.ts";
import { exists } from "../project.ts";

export type Sanitizer = "thread" | "none";

/** One report ThreadSanitizer wrote: what it found, where, and both stacks. */
export interface SanitizerReport {
  /** `data race`, `heap-use-after-free`… */
  kind: string;
  /** Its summary line: `data race Recorder.swift:42 in Stats.add(_:)`. */
  summary: string;
  /** The access it caught (`Write of size 8 by thread T3`) and its stack. */
  access: string;
  stack: string;
  /** The other access it conflicts with, and its stack. */
  previous?: string;
  previous_stack?: string;
}

const FRAMES = 8;

/**
 * Reads the reports ThreadSanitizer wrote to `dir` (`TSAN_OPTIONS=log_path=<dir>/report`, one
 * file per process), one per race; the same race reported twice counts once.
 */
export async function readSanitizerReports(dir: string): Promise<SanitizerReport[]> {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("report")).sort();
  const reports: SanitizerReport[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const report of parseSanitizerLog(await readFile(join(dir, file), "utf8"))) {
      if (seen.has(report.summary)) continue;
      seen.add(report.summary);
      reports.push(report);
    }
  }
  return reports;
}

/** Splits a ThreadSanitizer log into its reports (each between lines of `=`). */
export function parseSanitizerLog(text: string): SanitizerReport[] {
  const reports: SanitizerReport[] = [];
  for (const block of text.split(/^=+\s*$/m)) {
    const warning = /WARNING: ThreadSanitizer: (.+?)(?: \(pid=\d+\))?\s*$/m.exec(block);
    if (!warning) continue;
    const kind = warning[1]!.trim();
    const summary = /^SUMMARY: ThreadSanitizer: (.+)$/m.exec(block)?.[1]?.trim() ?? kind;
    // Sections are a header line (`  Write of size 8 at 0x… by thread T2:`) and its frames (`    #0 …`).
    const sections: { header: string; frames: string[] }[] = [];
    for (const line of block.split("\n")) {
      const frame = /^\s+#(\d+)\s+(.*)$/.exec(line);
      if (frame && sections.length) {
        const current = sections.at(-1)!;
        if (current.frames.length < FRAMES) current.frames.push(`#${frame[1]} ${tidyFrame(frame[2]!)}`);
      } else if (/^\s{2}\S.*:\s*$/.test(line)) {
        sections.push({ header: line.trim().replace(/:\s*$/, ""), frames: [] });
      }
    }
    const accesses = sections.filter((s) => /\b(read|write|atomic)\b/i.test(s.header) && !/^Location\b|^Thread\b|^Mutex\b/.test(s.header));
    const [first, second] = accesses;
    reports.push({
      kind,
      summary,
      access: first ? withoutAddress(first.header) : kind,
      stack: first?.frames.join("\n") ?? "",
      ...(second ? { previous: withoutAddress(second.header), previous_stack: second.frames.join("\n") } : {}),
    });
  }
  return reports;
}

/** `Write of size 8 at 0x7b0c00001234 by thread T2` → `Write of size 8 by thread T2`. */
function withoutAddress(header: string): string {
  return header.replace(/ at 0x[0-9a-f]+/i, "");
}

/** Drops the image offset at the end of a frame: `(Recorder:arm64+0x1a2b)`. */
function tidyFrame(frame: string): string {
  return frame.replace(/\s+\([^()]*\+0x[0-9a-f]+\)\s*$/i, "").trim();
}

/** ThreadSanitizer's runtime in the active toolchain, loaded into the test process at start. */
export async function threadSanitizerLibrary(): Promise<string | undefined> {
  const swift = (await runScript("xcrun --find swift", { cwd: "/", timeoutMs: 30_000 })).stdout.trim();
  if (!swift) return undefined;
  const library = join(dirname(swift), "..", "lib", "swift", "clang", "lib", "darwin", "libclang_rt.tsan_osx_dynamic.dylib");
  return (await exists(library)) ? library : undefined;
}

/**
 * Why ThreadSanitizer can't run on this Mac, if it can't: a tiny program built with it must
 * start. Sanitizers built with Xcode 26.3 or older crash or hang on macOS 26.4 and later.
 */
export async function threadSanitizerProblem(): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "windtunnel-tsan-"));
  try {
    await writeFile(join(dir, "main.c"), "int main(void) { return 0; }\n");
    const build = await runScript("xcrun clang -fsanitize=thread main.c -o main", { cwd: dir, timeoutMs: 60_000 });
    if (build.code !== 0) return `can't build with ThreadSanitizer: ${build.stderr.trim().split("\n").at(-1) ?? `exit ${build.code}`}`;
    const run = await runScript("./main", { cwd: dir, timeoutMs: 20_000 });
    if (run.code === 0) return undefined;
    const [macos, xcode] = await Promise.all([
      runScript("sw_vers -productVersion", { cwd: dir, timeoutMs: 10_000 }).then((r) => r.stdout.trim()),
      runScript("xcodebuild -version", { cwd: dir, timeoutMs: 30_000 }).then((r) => /Xcode ([\d.]+)/.exec(r.stdout)?.[1] ?? ""),
    ]);
    const how = run.timedOut ? "hangs" : run.code >= 128 ? "crashes as it starts" : `exits with ${run.code}`;
    const known = older(macos, "26.4") === false && xcode && older(xcode, "26.4")
      ? `: macOS ${macos} needs Xcode 26.4 or newer for sanitizers, and this is Xcode ${xcode} (Apple's known issue 171762808)`
      : ` with macOS ${macos || "?"} and Xcode ${xcode || "?"}`;
    return `a program built with ThreadSanitizer ${how}${known}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether version `a` is older than `b` (`26.0.1` < `26.4`). */
function older(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

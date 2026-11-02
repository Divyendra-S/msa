import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findScenario, type ProbePoint, probePoints, swiftFiles } from "@windtunnel/core";
import { blankComments, lineAt, matchBrace } from "./phone-code.ts";

/** A Swift Mac app's code as Wind Tunnel tests it: its probe points, where more could go, and its scenarios. */
export interface MacApp {
  framework: string;
  /** Points already in the code, with the function they are in and the comment above them. */
  points: (ProbePoint & { in?: string; comment?: string })[];
  /** Concurrency in the code: where a probe point lets a run hold, fail or cancel what matters. */
  sites: ConcurrencySite[];
  /** The XCTest methods experiments can run as scenarios, and the steps each marks. */
  scenarios: { id: string; file: string; line: number; steps: string[] }[];
}

export interface ConcurrencySite {
  kind: string;
  file: string;
  /** Every line it is on in one function (three file writes in `save` are one site). */
  lines: number[];
  /** The type and function it is in: `TakeWriter.append`. */
  in?: string;
  /** Why it matters for a race, in a few words. */
  note: string;
  /** A probe point is already within a few lines. */
  probed: boolean;
}

/** What to look for, and why each is a place for a probe point. */
const SITES: { kind: string; pattern: RegExp; note: string }[] = [
  { kind: "actor", pattern: /\bactor\s+\w+/g, note: "one call at a time, but each await inside lets another call in (reentrancy)" },
  { kind: "task", pattern: /\bTask\s*(?:\([^)]*\))?\s*\{/g, note: "runs alongside its caller; nothing waits for it unless something awaits its value" },
  { kind: "detached task", pattern: /\bTask\.detached\b/g, note: "runs alongside, without the caller's actor, priority or cancellation" },
  { kind: "task group", pattern: /\bwith(?:Throwing)?(?:Discarding)?TaskGroup\b|\basync let\b/g, note: "children run at once; their order is up to the scheduler" },
  { kind: "dispatch queue", pattern: /\bDispatchQueue\b[^\n]*|\.async\s*\{/g, note: "a callback on another thread; shared state needs a lock or an actor" },
  { kind: "unchecked shared state", pattern: /@unchecked\s+Sendable|nonisolated\(unsafe\)/g, note: "the compiler doesn't check it: a data race unless every access is locked" },
  { kind: "asset writer", pattern: /\bAVAsset(?:Writer|ExportSession)\b/g, note: "appends, finish and cancel race with stop; an unfinished movie doesn't open" },
  { kind: "file write", pattern: /\bFileHandle\s*\(\s*forWriting|\.write\(\s*(?:to|contentsOf)\b|FileManager\.default\.(?:createFile|moveItem|copyItem|replaceItemAt|removeItem)\b/g, note: "what is on disk if the task stops here, or another writes the same file" },
  { kind: "cancellation", pattern: /\bTask\.checkCancellation\(\)|\bTask\.isCancelled\b|\bwithTaskCancellationHandler\b/g, note: "what is left half-done when it stops here?" },
  { kind: "continuation", pattern: /\bwith(?:Checked|Unsafe)(?:Throwing)?Continuation\b/g, note: "must resume exactly once, whatever order the callbacks come in" },
];

/** Probe points closer than this many lines count as already covering a site. */
const NEAR = 3;

/** Reads a Swift package (a `Package.swift` in `dir`); undefined when there is none. */
export async function findMacApp(dir: string): Promise<MacApp | undefined> {
  const manifest = await readFile(join(dir, "Package.swift"), "utf8").catch(() => undefined);
  if (manifest === undefined) return undefined;
  const files = await swiftFiles(dir);
  const points = await probePoints(dir, files);
  const sites: ConcurrencySite[] = [];
  const scenarios: MacApp["scenarios"] = [];
  const enriched: MacApp["points"] = [];
  for (const { file, text } of files) {
    if (file === "Package.swift" || file.startsWith(".")) continue;
    const code = blankComments(text);
    if (file.startsWith("Tests/")) {
      for (const cls of code.matchAll(/\bclass\s+(\w+)\s*:\s*XCTestCase\b/g)) {
        for (const fn of code.slice(cls.index).matchAll(/\bfunc\s+(test\w*)\s*\(/g)) {
          const found = await findScenario(dir, `${cls[1]}/${fn[1]}`, files);
          if (found && !scenarios.some((s) => s.id === `${cls[1]}/${fn[1]}`)) scenarios.push({ id: `${cls[1]}/${fn[1]}`, file, line: found.line, steps: found.steps });
        }
      }
      continue;
    }
    const here = points.filter((p) => p.file === file);
    const scopes = scopesOf(code);
    for (const site of SITES) {
      for (const m of code.matchAll(site.pattern)) {
        const line = lineAt(text, m.index);
        const around = enclosing(scopes, m.index);
        const probed = here.some((p) => Math.abs(p.line - line) <= NEAR);
        const same = sites.find((x) => x.file === file && x.kind === site.kind && x.in === around.in);
        if (same) {
          if (!same.lines.includes(line)) same.lines.push(line);
          same.probed ||= probed;
        } else sites.push({ kind: site.kind, file, lines: [line], ...around, note: site.note, probed });
      }
    }
    for (const p of here) {
      const at = indexOfLine(text, p.line);
      // The comment above the point, else the one on the function it is in.
      const fn = scopes.filter((x) => !x.type && x.start < at && at < x.end).at(-1);
      const comment = commentAbove(text, at) ?? (fn ? commentAbove(text, text.lastIndexOf("\n", fn.decl) + 1) : undefined);
      enriched.push({ ...p, ...enclosing(scopes, at), ...(comment ? { comment } : {}) });
    }
  }
  sites.sort((a, b) => a.file.localeCompare(b.file) || a.lines[0]! - b.lines[0]!);
  return { framework: "Swift (Mac)", points: enriched, sites, scenarios };
}

/** Types and functions in the code, with the span of their bodies. */
function scopesOf(code: string): { name: string; type: boolean; decl: number; start: number; end: number }[] {
  const scopes: { name: string; type: boolean; decl: number; start: number; end: number }[] = [];
  for (const m of code.matchAll(/\b(?:(class|struct|actor|enum|extension)\s+(\w+)|func\s+(\w+)|(init)\s*[(<])/g)) {
    const open = code.indexOf("{", m.index);
    if (open < 0) continue;
    // A protocol requirement or a declaration without a body ends before any brace.
    const semicolonOrNewDecl = /\n\s*(?:func|var|let|case)\b/.exec(code.slice(m.index + m[0].length, open));
    if (m[3] && semicolonOrNewDecl) continue;
    scopes.push({ name: (m[2] ?? m[3] ?? m[4])!, type: !!m[1], decl: m.index, start: open, end: matchBrace(code, open) });
  }
  return scopes;
}

/** The type and function around an index: `{ in: "TakeWriter.append" }`, or nothing at the top level. */
function enclosing(scopes: ReturnType<typeof scopesOf>, index: number): { in?: string } {
  const around = scopes.filter((x) => x.start < index && index < x.end);
  const type = around.filter((x) => x.type).at(-1)?.name;
  const fn = around.filter((x) => !x.type).at(-1)?.name;
  const parts = [type, fn].filter(Boolean);
  return parts.length ? { in: parts.join(".") } : {};
}

function indexOfLine(text: string, line: number): number {
  let index = 0;
  for (let n = 1; n < line; n++) index = text.indexOf("\n", index) + 1;
  return index;
}

/** The `///` or `//` comment right above a line, joined. */
function commentAbove(text: string, index: number): string | undefined {
  const lines = text.slice(0, index).split("\n").slice(0, -1);
  const comment: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*\/\/\/?\s?(.*)$/.exec(lines[i]!);
    if (!m) break;
    comment.unshift(m[1]!.trim());
  }
  return comment.length ? comment.join(" ") : undefined;
}

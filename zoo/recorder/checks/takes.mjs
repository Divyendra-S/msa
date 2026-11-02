// Rule checks for the recorder (.windtunnel/rules.yaml): reads what a run left in $DATA_DIR and
// prints one JSON line per thing that breaks the rule.
//
//   node checks/takes.mjs whole     every take and export opens: frames, then an index that counts them, then nothing
//   node checks/takes.mjs open      no take was left half-written (a .partial file)
//   node checks/takes.mjs exports   every export has its take's frames, converted at its preset
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DATA_DIR;
if (!dir) throw new Error("DATA_DIR is not set");
const files = readdirSync(dir).sort();
const isTake = (f) => f.endsWith(".take") || f.endsWith(".export");

/** Reads a take as the app does; `problem` says where it stops making sense. */
function readTake(file) {
  const data = readFileSync(join(dir, file));
  let at = 0;
  const line = () => {
    const end = data.indexOf(10, at);
    if (end < 0) return undefined;
    const text = data.subarray(at, end).toString("latin1");
    at = end + 1;
    return text;
  };
  const header = line();
  if (!header?.startsWith("WTAKE 1")) return { header, frames: [], problem: "no take header" };
  const frames = [];
  for (;;) {
    const record = line();
    if (record === undefined) return { header, frames, problem: `no index after ${frames.length} frame(s): never finished` };
    const index = /^INDEX (\d+)$/.exec(record);
    if (index) {
      if (Number(index[1]) !== frames.length) return { header, frames, problem: `the index counts ${index[1]} frame(s), the take has ${frames.length}` };
      if (line() !== "END") return { header, frames, problem: "no END after the index" };
      if (at !== data.length) return { header, frames, problem: `${data.length - at} byte(s) after the end` };
      return { header, frames };
    }
    const frame = /^F (\d+) (\d+)$/.exec(record);
    if (!frame) return { header, frames, problem: `a broken record after frame ${frames.length}: ${JSON.stringify(record.slice(0, 40))}` };
    const length = Number(frame[2]);
    if (at + length >= data.length || data[at + length] !== 10) return { header, frames, problem: `frame ${frame[1]} is cut short` };
    frames.push({ index: Number(frame[1]), pixels: data.subarray(at, at + length) });
    at += length + 1;
  }
}

const convert = (pixels, preset) => (preset === "half" ? pixels.filter((_, i) => i % 2 === 0) : pixels);

const rows = [];
switch (process.argv[2]) {
  case "whole":
    for (const file of files.filter(isTake)) {
      const { problem } = readTake(file);
      if (problem) rows.push({ file, problem });
    }
    break;
  case "open":
    for (const file of files.filter((f) => f.endsWith(".partial"))) rows.push({ file, problem: "left half-written: never finished" });
    break;
  case "exports":
    for (const file of files.filter((f) => f.endsWith(".export"))) {
      const take = readTake(file);
      const meta = Object.fromEntries((take.header ?? "").split(" ").slice(2).map((kv) => kv.split("=")));
      if (!meta.source || !meta.preset) {
        rows.push({ file, problem: `no source or preset in its header: ${JSON.stringify(take.header?.slice(0, 60))}` });
        continue;
      }
      const source = readTake(meta.source);
      if (source.problem) continue;
      const bad = source.frames.find((f, i) => !take.frames[i] || !convert(f.pixels, meta.preset).equals(take.frames[i].pixels));
      if (take.frames.length !== source.frames.length || bad) {
        rows.push({
          file,
          source: meta.source,
          preset: meta.preset,
          problem: bad ? `frame ${bad.index} isn't its take's frame at ${meta.preset}` : `${take.frames.length} frame(s), its take has ${source.frames.length}`,
        });
      }
    }
    break;
  default:
    throw new Error("usage: node checks/takes.mjs whole|open|exports");
}
for (const row of rows) console.log(JSON.stringify(row));

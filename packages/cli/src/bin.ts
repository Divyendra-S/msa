#!/usr/bin/env node
import { parseArgs } from "node:util";
import { main } from "./main.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string" },
    ref: { type: "string" },
    patch: { type: "string" },
    "keep-db": { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    repeat: { type: "string" },
    trace: { type: "string" },
    headed: { type: "boolean", default: false },
    limit: { type: "string" },
    json: { type: "boolean", default: false },
    focus: { type: "string" },
    base: { type: "string" },
    "base-patch": { type: "string" },
    "no-schema": { type: "boolean", default: false },
    out: { type: "string" },
    prefix: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

process.exitCode = await main(positionals, values);

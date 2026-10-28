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
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

process.exitCode = await main(positionals, values);

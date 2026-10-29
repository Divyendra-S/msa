// Stands in for `claude -p … --output-format stream-json` in the viewer tests: records its
// arguments and environment in $WT_FAKE_LOG, then prints a few events in Claude Code's shapes.
import { writeFileSync } from "node:fs";

const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
writeFileSync(process.env.WT_FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
out({ type: "system", subtype: "init", model: "claude-sonnet-5-5", tools: ["Read"], mcp_servers: [{ name: "plugin:windtunnel:windtunnel", status: "connected" }] });
const usage = { input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 40 };
out({ type: "assistant", message: { content: [{ type: "text", text: "Mapping checkout." }], usage } });
out({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__plugin_windtunnel_windtunnel__windtunnel_map", input: { focus: "checkout" } }], usage } });
out({ type: "user", message: { content: [{ type: "tool_result", content: "map…" }] } });
out({ type: "result", subtype: "success", result: "Found a double charge.", total_cost_usd: 0.42, usage: { input_tokens: 1000, cache_read_input_tokens: 4000, output_tokens: 60 } });

// Stands in for `muse exec --json <prompt>` in the viewer tests: a few JSONL events in the shapes
// agents use, a plain line, a stderr line, then exit. A prompt containing "slow" waits to be stopped.
const prompt = process.argv.at(-1);
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

out({ type: "thread.started", thread_id: "t1" });
await wait(30);
out({ type: "item.completed", item: { type: "agent_message", text: "Mapping the app." } });
out({ type: "item.started", item: { type: "mcp_tool_call", server: "windtunnel", tool: "windtunnel_map", arguments: { focus: "checkout" } } });
process.stdout.write("plain output line\n");
process.stderr.write("warning: from stderr\n");
out({
  type: "item.completed",
  item: { type: "agent_message", text: `env ${process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY ? "leaked" : "clean"} job=${process.env.WINDTUNNEL_JOB} key=${process.env.MODEL_API_KEY ? "set" : "unset"} prompt=${prompt}` },
});
if (prompt.includes("slow")) {
  process.on("SIGINT", () => process.exit(130));
  await wait(30_000);
}
out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 80 } });

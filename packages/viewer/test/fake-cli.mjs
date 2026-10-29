// Stands in for the windtunnel CLI in the viewer tests: prints its arguments and whether any
// agent's key reached it, then exits like `windtunnel run` (1 when an experiment didn't pass).
// An id containing "slow" waits to be stopped; "broken" stops on an error.
const args = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`args ${args.join(" ")}`);
console.log(`env ${Object.keys(process.env).some((k) => /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_)/.test(k)) ? "leaked" : "clean"}`);
if (args.some((a) => a.includes("slow"))) {
  process.on("SIGINT", () => process.exit(130));
  await wait(30_000);
}
if (args.some((a) => a.includes("broken"))) {
  process.stderr.write("error: unknown experiment(s): broken\n");
  process.exit(1);
}
console.log("send-twice  fail  at-most-one-hit 1/1");
process.exit(1);

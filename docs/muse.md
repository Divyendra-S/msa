# Muse setup

The hackathon submission runs on Meta's models: Muse Code (the agent) with Muse Wonder for the
main loop, and Muse Spark for Wind Tunnel's own small decisions. Everything is billed to one
Meta key, kept in a shell of its own.

## Day 0

1. **Install Muse Code** ([docs](https://dev.meta.ai/docs/muse-code)) and check `muse --version`.
2. **The key.** Put it in `~/.config/windtunnel/meta-key` (one line, `chmod 600`), or let the
   script ask for it each time. Then, in a new terminal used only for Muse:

   ```sh
   source scripts/muse-env.sh
   ```

   It sets `MODEL_API_KEY` (Wind Tunnel: Muse Spark decisions, Run hunt, the benchmark) and
   `META_API_KEY` (Muse Code's headless runs), and puts `(muse)` in front of the prompt.
   Never source it in the terminal where you use your own Claude Code or Codex: there the key
   would reach other tools, and with `--claude` your Claude Code requests would go to Meta.
3. **Set up the agent:** `windtunnel install --hosts muse` copies the skills to
   `~/.agents/skills/windtunnel-*` and adds the MCP server to `~/.config/muse/settings.json`
   (keeping what is there, with a backup).
4. **Check it:**

   ```sh
   pnpm bench check          # free: muse, the `muse exec` flags the benchmark uses, the key
   pnpm bench check --paid   # a few cents: one Spark decision and one short Muse Code run on Spark
   ```

   The paid check runs Muse Code the way a benchmark trial does (its own HOME with the MCP
   server and skills, no other agent's variables) and asks it to reach Postgres and a local
   port and to name its Wind Tunnel skills and tools. Its events are kept in
   `$TMPDIR/windtunnel-muse-check/events.jsonl`.

| Line | If it fails |
|---|---|
| `exec --…` | A flag the benchmark passes isn't in `muse exec --help`: change `MUSE_COMMAND` in `bench/src/hosts.ts` and `hunt.command`'s default in `packages/core/src/config.ts` |
| `Spark decision` | The key, or the model name (`decider.spark.model`) |
| `signed in` | Muse Code wants a login despite `META_API_KEY` when HOME is its own: run the benchmark with `--shared-home` (it then sees your own skills and servers too; say so with the results) |
| `JSONL events`, `usage in events` | Read `events.jsonl` and teach `readEvent` in `packages/viewer/src/hunt.ts` the field names; the viewer's hunt log and the benchmark's token counts both use it |
| `sandbox → pg`, `sandbox → port` | Muse Code's sandbox blocks local network access. Experiments need Postgres and the app's ports: look for a sandbox setting that allows localhost, or run with `--yolo` (no sandbox) in a throwaway folder only |
| `skills`, `MCP server` | Muse Code looks elsewhere for user skills or servers: adjust `windtunnel install` (`packages/cli/src/install.ts`) and the trial setup (`bench/src/trial.ts`) |

Then the same on a real case, cheaply: `pnpm bench run --cases 05 --setups B --model
muse-spark-1.3 --time-cap 15m`. Repeat that smoke test on days 4, 6 and 9: skills tuned on
Claude can behave differently on Muse.

## Running it

| | |
|---|---|
| Viewer | `windtunnel view` in the Muse shell: **Run hunt** starts `muse exec --json` in the app's folder and streams its events |
| Benchmark | `pnpm bench run --cases all --setups A,B,C --time-cap 30m` (Muse Wonder); see [`bench/README.md`](../bench/README.md) |
| Demo | [`docs/demo.md`](demo.md) |

**Credits:** Spark for development runs (`--model muse-spark-1.3`), Wonder for the published
numbers and the demo. Every run is capped (`--max-model-steps`, the benchmark's time cap),
and the viewer and `windtunnel usage` show what Wind Tunnel's own decisions cost. Don't use
Meta's "contributor" models with code: Meta trains on their prompts and outputs.

## Backup host: Claude Code pointed at Muse

If Muse Code misbehaves, Claude Code can run on Muse models with the same plugin:

```sh
source scripts/muse-env.sh --claude
claude --plugin-dir ./plugins/windtunnel
```

`--claude` also sets Meta's documented Claude Code variables (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN` and every model variable pointing at a Muse model) and unsets
`ANTHROPIC_API_KEY`. Results from this host are reported as such, not as Muse Code runs.

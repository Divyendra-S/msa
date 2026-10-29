# Bug Zoo benchmark

Does Wind Tunnel help a coding agent find, reproduce and fix real bugs, and at what cost? The
benchmark gives the same agent the same task on each [Bug Zoo](../zoo/cases/README.md) case,
in three setups, and scores the result without a model.

| Setup | The agent has |
|---|---|
| **A** | Playwright MCP (`@playwright/mcp`), no Wind Tunnel |
| **B** | Wind Tunnel: MCP server and skills, rules only (`WINDTUNNEL_DECIDER=rules`) |
| **C** | Wind Tunnel with Muse Spark answering its small decisions (`WINDTUNNEL_DECIDER=spark`) |

For the published numbers every setup runs on Muse Code with Muse Wonder, with the same time
cap and the same [task](task.md). That prompt asks the agent to find bugs in checkout and
orders, reproduce, fix and prove each one, and finish with `bench-report.json`: a list of
findings, each with the files involved and one shell command that fails while the bug is
there and passes once it is fixed.

## A trial

`pnpm bench` makes one folder per case and setup, outside this repository (default
`$TMPDIR/windtunnel-bench/<batch>/<id>`), so the agent can't read the answers. Nothing the
agent can see names the case: the folder's id is random, `trial.json` keeps the case as a
hash, and the job id in its environment is the folder's id.

| | |
|---|---|
| `app/` | the shop with the case's bug (or a control's decoy) applied, as a single commit: no history, no answer key. A: no Wind Tunnel files. B and C: `windtunnel.config.yaml` and the login flow, as after `/windtunnel:init`; the agent writes its own rules and experiments |
| `bin/` | `mock-pay` (the payment provider, for `scripts/local.mjs`) and, for B and C, `windtunnel` |
| `home/` | the agent's HOME: `.config/muse/settings.json` with this setup's MCP servers, and for B and C the skills in `.agents/skills` |
| `mcp.json` | the same MCP servers for Claude Code (`--mcp-config`), for trials run by hand |
| `task.md`, `trial.json` | the task, and what was run |
| `events.jsonl`, `host.log` | the agent's JSONL events and its stderr |
| `score.json` | the score |

The agent runs with its own HOME, so it sees only this setup's servers and skills. Browser,
npm and pnpm caches stay where they are. No `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*` or
`CODEX_*` variable reaches it. `META_API_KEY` is set from `MODEL_API_KEY` when only the latter
is there.

## Scoring

No model is involved. `score.json`, and one row of the scoreboard:

- **Found**: a finding's `reproduce` command fails with the bug (on the trial's first commit,
  with the agent's tests and reproductions copied in) and passes on the clean shop (the same,
  without the bug), in every run on the clean shop. Only the seeded bug differs between the
  two, so such a command reproduces that bug. `claimed`: a finding names the bug's file but
  gives no command.
- **Reproduced**: how many runs of that command failed with the bug (default 3).
- **File**: the matching finding names the file the bug is in.
- **Fixed**: the case's own hidden experiment (the zoo's flows, rules and experiments, not the
  agent's) passes in every run (default 5) on the agent's final code.
- **Regressions**: the zoo's other experiments that no longer pass on the final code (default
  1 run each).
- **False alarms**: on a control, every finding. On a bug case, findings whose command never
  fails with the bug, and claims without a command that don't name the bug's file. A command
  that fails on the clean shop too is listed (`also on clean`) but isn't counted: it may be a
  real bug.
- **Tokens, credits, time**: from the host's JSONL usage events; credits from the reported
  prices when the host reports none (marked `~`), plus Wind Tunnel's Level 1 spend from its
  usage log. Wall time is the host process.

Reproductions and hidden checks run with rules only and no model keys, so scoring spends
nothing. A note is added if the agent's events mention this repository or the case files.

## Running it

```sh
# The published benchmark: Muse Code with Muse Wonder, the Meta key in this shell only
source scripts/muse-env.sh
pnpm bench run --cases all --setups A,B,C --time-cap 30m

# A cheap check on Muse Spark
pnpm bench run --cases 05,09,c1 --setups B --model muse-spark-1.3 --time-cap 15m

# Print (and write) the scoreboard of the latest batch, or of one
pnpm bench board [--batch <name>]
```

Results go to `bench/results/<batch>/`: per trial the score, the agent's report and its diff,
and `scoreboard.md`. They are committed with the scripts that made them.

`--host muse` (default) runs `muse exec --json --disable-approval --max-model-steps 200 --model
<model> --prompt-file <task>` in the trial's `app/`. `--command "<cmd> {prompt_file}"` runs any
other agent that prints JSONL (`{model}`, `{max_steps}` and `{prompt_file}` are filled in).
The benchmark refuses to start `claude` or `codex` itself: they run on their user's own login.

To try the harness without Muse, use the stand-in agent. It fixes case 09 and reports it with
a reproduction (a Wind Tunnel experiment in setups B and C, a script run by `scripts/local.mjs`
in A), plus a made-up finding that never reproduces:

```sh
pnpm bench run --cases 09 --setups A --command "node $PWD/bench/test/fake-agent.mjs {prompt_file}" --batch try --no-publish
```

### By hand, in Claude Code (development)

Development runs on your own Claude login are interactive and don't count for the published
numbers:

```sh
pnpm bench prepare --case 09 --setup B --host manual   # prints the folder, the command to start Claude Code, and the task
# … run it, then:
pnpm bench score <trial folder> --tokens <session total> --minutes <m>
```

Setup C needs `MODEL_API_KEY` in the MCP server's environment. Run it on Muse Code.

## Options

`--parallel <n>` (agents at once, each with its own `PORT`; scoring still runs one trial at a
time) · `--batch <name>` (default `<date>-<time>-<host>`) · `--trials <dir>` · `--time-cap 30m` ·
`--max-steps 200` · `--model` · `--fix-runs 5` · `--regression-runs 1` · `--repro-runs 3` ·
`--no-install` · `--no-score` · `--no-publish` · `--shared-home` (use your own HOME) · `--quiet`

`pnpm bench check [--paid]`: day-0 check of the Muse setup ([`docs/muse.md`](../docs/muse.md)).

## Fairness

- Same model, prompt, time cap and step cap for every setup. Scripts and raw results are
  committed.
- The skills' rule and flow examples use another domain (ticket bookings, documents), so
  setups B and C aren't handed the zoo's rules. The prove skill's list of usual fixes
  (idempotency keys, webhook dedupe, conditional updates) is general know-how, part of what the
  benchmark measures.
- The shop's README and `scripts/local.mjs` (start everything, run a command against it)
  are in every setup, so setup A can reproduce bugs without Wind Tunnel.
- Controls look risky to pattern matching (the map flags them too) but are correct.

## Not checked yet

Muse Code isn't installed here. From its docs: `--json`, `--disable-approval`,
`--max-model-steps` and `--prompt-file` exist, MCP servers live in the user's
`~/.config/muse/settings.json`, project skills in `.agents/skills`, and CI runs read
`META_API_KEY`. Not documented, so unverified: `--model` on `exec`, the JSONL event schema
(the reader handles Codex- and Claude-style events), whether HOME isolation keeps Muse Code
signed in, and whether its sandbox lets the agent reach Postgres and local ports. `pnpm bench check --paid`
checks all of them in the Muse shell, for a few cents; see [`docs/muse.md`](../docs/muse.md).

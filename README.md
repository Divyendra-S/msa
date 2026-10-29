# Software Wind Tunnel

> Your coding agent says it fixed the bug. Make it prove it.

A free, open-source (MIT) tool that runs real-world failure experiments against a web
app — double clicks, lost responses, duplicate webhooks, races — against the real backend
and database, traces what broke, and proves a fix by re-running the experiment.

- Product plan: [`plan.md`](plan.md)
- Build plan by phase: [`execution-plan.md`](execution-plan.md)

## Install

```sh
npx windtunnel-cli install
```

Checks Node 22.18+, git, Docker, Postgres and Playwright's Chromium, puts the `windtunnel`
CLI on your PATH, and adds the plugin to the coding agents it finds (Claude Code, Codex,
Muse Code) after one confirmation. Then, in your app's folder, ask your agent for
`/windtunnel:init` (Claude Code, Codex) or the `windtunnel-init` skill (Muse Code), then
`/windtunnel:hunt checkout`. Next.js + Postgres apps for now. Details:
[`docs/agents.md`](docs/agents.md); the Meta setup for Muse Code: [`docs/muse.md`](docs/muse.md).

**Status:** Phases 1–7 are done: isolated branches; the experiment engine (flows,
perturbations, ordered races, webhook control, rules, database diff, repeat runs, run
store); the agent connection (an MCP server, skills and a plugin for Claude Code, Codex
and Muse Code, the static app map, evidence packets, Bug Zoo cases 1–7); fix proof (the
prover with the project's tests in its regression set, proof branches with `EVIDENCE` files,
the SQL trace chain, and re-running only the experiments a change affects); and the
efficiency layer (a live crawl with a free sweep for console errors, failed requests, broken
links, accessibility and slow pages; failure sorting; selector repair written back to the
flow; a Decider that answers small decisions with rules, then Muse Spark or Jev, then the
agent; and a usage meter with per-job budgets); and the local viewer (runs as they happen,
aligned timelines, first divergence, trace chain, database changes, rules, usage, a Run hunt
button for Muse Code and an Open in Claude Code link); and the full Bug Zoo (ten cases and
three clean controls, with rules that can read what users got and saw) with the benchmark
harness for setups A, B and C, scored without a model. Phase 8 (submission) so far: the npm
package and `windtunnel install`, the Muse shell and day-0 check, and the demo app; the Muse
benchmark runs and the video come next.

## Layout

```
packages/
  core/       config, isolated branches (worktree + Postgres copy + app process),
              experiment runner (flows, perturbations, races, webhooks), rules, DB diff, SQL log,
              run store, evidence packets and trace chain, prover and proof branches
  explorer/   app map: Next.js routes, what each handler does, risky patterns, pages, schema, and a
              live crawl with the free sweep; which experiments a code change affects; the Decider
              (rules → Muse Spark or Jev → agent), selector repair and failure sorting
  mcp/        MCP server (map, validate, run, evidence, branch, prove, decide) with the usage meter
  cli/        `windtunnel` CLI, `install`; build.ts bundles the npm package (windtunnel-cli)
  viewer/     local API (HTTP + event stream) and web viewer (Vite + React in app/), Run hunt
apps/
  mac/        native Mac app (SwiftUI) over the local API: runs, races, trace chain, experiments,
              hunts with Claude 5 (your Claude Code, or an API key) and Muse Code
plugins/
  windtunnel/ plugin for Claude Code and Codex: skills (init, hunt, prove, test), MCP server,
              helper subagent
  muse-code/  Muse Code setup (same skills, MCP settings)
zoo/
  shop/       Bug Zoo demo shop: Next.js + Postgres, standalone app with its own lockfile;
              its .windtunnel/ holds the reference flows, experiments and rules
  mock-pay/   mock payment provider: idempotent charges, signed webhooks, harness control
  cases/      one bug patch per case (or decoy patch per control) + expected results + verifier;
              prover and healing checks
  demo/       the demo app: three bugs at once (demo.patch) and setup.ts
scripts/
  muse-env.sh the Muse shell: the Meta key for Muse Code and Wind Tunnel, kept out of other shells
bench/        the benchmark: trials per case and setup, Muse Code runner, scoring, scoreboard;
              results/ holds committed runs
docs/
  experiments.md   flow, experiment and rules reference
  agents.md        skills, MCP tools, app map, live crawl and sweep, evidence packets, trace chain,
                   affected runs, failure sorting and repair, the Decider, usage meter, proof
  viewer.md        the viewer, Run hunt, Open in Claude Code, the local API
  muse.md          Muse Code setup, day-0 checks, the backup host
  demo.md          the demo app and script
```

## Development setup

Requirements: Node 22.18+ (`nvm use` picks Node 24), pnpm 10, Docker.

```sh
pnpm install                 # workspace packages
pnpm zoo:install             # the shop (standalone, own lockfile)
pnpm db:up                   # Postgres 17 on localhost:55432 (docker compose)
pnpm --dir packages/core exec playwright install --only-shell chromium
```

Checks:

```sh
pnpm typecheck               # packages, tests and the shop's flow files
pnpm test                    # unit + integration tests (branches, runner; need pnpm db:up)
pnpm zoo:verify              # every shop experiment against the clean shop, each bug and each control
pnpm zoo:prove               # the prover: proves each case's real fix, rejects the wrong fixes
pnpm zoo:heal                # failure sorting and selector repair on a copy of the shop, rules only
```

TypeScript runs directly on Node (type stripping), so there is no build step in
development. Source files use erasable syntax only and `.ts` import extensions.

The npm package is the one exception, since Node doesn't strip types in `node_modules`:
`pnpm cli:build` bundles the CLI into `packages/cli/pkg/` with the viewer's UI, the plugin and
the marketplace files; `npm pack` (or `npm publish`) from there.

## Branches

A branch is one isolated execution of the app: a code version (a git worktree of the
working tree, a ref, or a ref plus a patch, cached by tree hash), a fresh copy of the
seeded database (`CREATE DATABASE … TEMPLATE`), its own payment-provider tenant, and a
running app process on a free port.

```sh
pnpm wt --cwd zoo/shop doctor        # Node, git, config, Postgres
pnpm wt --cwd zoo/shop prepare       # check out, install, build, seed snapshot (cached)
pnpm wt --cwd zoo/shop branch        # start a branch and keep it running (Ctrl-C stops it)
pnpm wt --cwd zoo/shop branch --patch zoo/cases/01-double-submit/bug.patch
pnpm wt --cwd zoo/shop clean [--all] # leftover processes and run databases (--all: snapshots, worktrees)
```

Worktrees live outside the repo in `~/.cache/windtunnel/` (override with
`WINDTUNNEL_CACHE_DIR`); the 10 most recently used versions are kept.

## Experiments

An experiment is a flow (a Playwright script split into named steps) plus perturbations,
races and webhook timing, checked against SQL rules after every run. Each run gets its own
branch; runs go in parallel up to `parallel` in the config.

```yaml
# zoo/shop/.windtunnel/experiments/checkout-lost-response.yaml
description: The app saves the order but the browser never gets the answer, so the user clicks "Pay now" again.
flow: checkout
perturb:
  - do: lose-response
    request: POST /api/orders
    step: pay
  - do: repeat
    step: pay
webhooks: late
```

```sh
pnpm wt --cwd zoo/shop run                          # every experiment, 3 runs each
pnpm wt --cwd zoo/shop run --affected               # only experiments whose code changed since their last result
pnpm wt --cwd zoo/shop run checkout-lost-response --patch zoo/cases/02-lost-response-retry/bug.patch
pnpm wt --cwd zoo/shop validate                     # check files without running
pnpm wt --cwd zoo/shop runs                         # recent runs
```

With the case 02 bug patched in:

```
version 75d73172bd48 (working tree + patch)

experiment              result  runs      rules broken              run
checkout-lost-response  FAIL    3 broken  one-charge-per-order 3/3  261028-121415-381c

1 experiment(s) · 3 run(s) · 2.5 s · details in zoo/shop/.windtunnel/runs/<run>
```

Each run leaves steps, a request log, the app's SQL (through a logging proxy), rule results,
a row-level database diff, the app log and (for failures) a Playwright trace in
`.windtunnel/runs/<run>/`. See
[`docs/experiments.md`](docs/experiments.md) for the full format.

## With a coding agent

```sh
claude --plugin-dir ./plugins/windtunnel      # Claude Code, from this checkout
```

Then, in the app's folder: `/windtunnel:init`, `/windtunnel:hunt checkout`,
`/windtunnel:prove <experiment>`, `/windtunnel:test`. The agent reads a map of the app built
from its code, writes rules and experiments, runs them, and reads short evidence packets.
Codex and Muse Code setup, the MCP tools and the formats are in
[`docs/agents.md`](docs/agents.md).

The same steps from the shell:

```sh
pnpm wt --cwd zoo/shop map --focus orders           # what each handler does, flagged patterns, schema
pnpm wt --cwd zoo/shop crawl --users alice,sam      # real control names per page, free sweep
pnpm wt --cwd zoo/shop evidence <run>               # evidence packet; <run>/1/trace or /1/diff:orders to drill down
pnpm wt --cwd zoo/shop prove checkout-two-buyers --base-patch zoo/cases/05-oversell/bug.patch
pnpm wt --cwd zoo/shop prove checkout-two-buyers --branch windtunnel/fix-oversell   # bug in HEAD, fix in the working tree
```

## Benchmark

```sh
pnpm bench run --cases all --setups A,B,C            # Muse Code on every case, in each setup (Meta key)
pnpm bench prepare --case 09 --setup B --host manual # one trial to run by hand in Claude Code
pnpm bench board                                     # the scoreboard
```

The same task on each Bug Zoo case: A without Wind Tunnel (Playwright MCP), B with it (rules
only), C with Muse Spark answering its small decisions. Each trial is a one-commit copy of the
shop outside this repository. A finding counts when its reproduce command fails with the bug
and passes on the clean shop; a fix counts when the case's hidden experiment passes on the
agent's final code. See [`bench/README.md`](bench/README.md).

| Setup (Muse Wonder) | Found | Fixed | False alarms | Tokens per proven fix | Time |
|---|---|---|---|---|---|
| A: Playwright MCP | — | — | — | — | — |
| B: Wind Tunnel, rules only | — | — | — | — | — |
| C: Wind Tunnel + Muse Spark | — | — | — | — | — |

No published runs yet: they need the Muse setup ([`docs/muse.md`](docs/muse.md)). The
scoreboard for each batch is in `bench/results/<batch>/scoreboard.md`.

## Demo

`pnpm demo:setup` makes the demo shop (three bugs at once) outside this repository; the script
and how to record it are in [`docs/demo.md`](docs/demo.md).

## Viewer

```sh
pnpm wt --cwd zoo/shop view
```

Opens a local page with every run as it happens. Runs started together are lined up side by
side, step by step. The page marks where a failing run first differs from one that held every
rule, and shows the trace chain from request to handler line to SQL, the database changes,
rules and screenshots. **Run hunt** starts Muse Code without a terminal, billed to the Meta
key in the viewer's shell, and streams its progress. **Open in Claude Code** opens a terminal
with the prompt typed for you to send. See [`docs/viewer.md`](docs/viewer.md).

## Mac app

```sh
pnpm mac:open
```

The same views as native SwiftUI, plus experiments you can run from the app and hunts with
Claude 5: in your own Claude Code (the app follows every run it starts) or headless on an
Anthropic API key. See [`apps/mac`](apps/mac/README.md).

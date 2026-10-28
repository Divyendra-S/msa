# Software Wind Tunnel

> Your coding agent says it fixed the bug. Make it prove it.

A free, open-source (MIT) tool that runs real-world failure experiments against a web
app — double clicks, lost responses, duplicate webhooks, races — against the real backend
and database, traces what broke, and proves a fix by re-running the experiment.

- Product plan: [`plan.md`](plan.md)
- Build plan by phase: [`execution-plan.md`](execution-plan.md)

**Status:** Phases 1–4 are done: isolated branches; the experiment engine (flows,
perturbations, ordered races, webhook control, rules, database diff, repeat runs, run
store); the agent connection (an MCP server, skills and a plugin for Claude Code, Codex
and Muse Code, the static app map, evidence packets, Bug Zoo cases 1–7); and fix proof (the
prover with the project's tests in its regression set, proof branches with `EVIDENCE` files,
the SQL trace chain, and re-running only the experiments a change affects).

## Layout

```
packages/
  core/       config, isolated branches (worktree + Postgres copy + app process),
              experiment runner (flows, perturbations, races, webhooks), rules, DB diff, SQL log,
              run store, evidence packets and trace chain, prover and proof branches
  explorer/   static app map: Next.js routes, what each handler does, risky patterns, pages, schema;
              which experiments a code change affects
  mcp/        MCP server (map, validate, run, evidence, branch, prove)
  cli/        `windtunnel` CLI
  viewer/     (later phase) web viewer
plugins/
  windtunnel/ plugin for Claude Code and Codex: skills (init, hunt, prove, test), MCP server,
              helper subagent
  muse-code/  Muse Code setup (same skills, MCP settings)
zoo/
  shop/       Bug Zoo demo shop: Next.js + Postgres, standalone app with its own lockfile;
              its .windtunnel/ holds the reference flows, experiments and rules
  mock-pay/   mock payment provider: idempotent charges, signed webhooks, harness control
  cases/      one bug patch per case + expected results + verifier; prover check
docs/
  experiments.md   flow, experiment and rules reference
  agents.md        skills, MCP tools, app map, evidence packets, trace chain, affected runs, proof
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
pnpm zoo:verify              # every shop experiment against the clean shop and each bug variant
pnpm zoo:prove               # the prover: proves each case's real fix, rejects the wrong fixes
```

TypeScript runs directly on Node (type stripping), so there is no build step in
development. Source files use erasable syntax only and `.ts` import extensions.

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
pnpm wt --cwd zoo/shop evidence <run>               # evidence packet; <run>/1/trace or /1/diff:orders to drill down
pnpm wt --cwd zoo/shop prove checkout-two-buyers --base-patch zoo/cases/05-oversell/bug.patch
pnpm wt --cwd zoo/shop prove checkout-two-buyers --branch windtunnel/fix-oversell   # bug in HEAD, fix in the working tree
```

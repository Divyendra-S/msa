# Software Wind Tunnel

> Your coding agent says it fixed the bug. Make it prove it.

A free, open-source (MIT) tool that runs real-world failure experiments against a web
app — double clicks, lost responses, duplicate webhooks, races — against the real backend
and database, traces what broke, and proves a fix by re-running the experiment.

- Product plan: [`plan.md`](plan.md)
- Build plan by phase: [`execution-plan.md`](execution-plan.md)

**Status:** Phase 1 (foundation) is done: isolated branches, the Bug Zoo shop, the mock
payment provider and Bug Zoo cases 1–3.

## Layout

```
packages/
  core/       config, isolated branches (worktree + Postgres copy + app process), rules
  cli/        `windtunnel` CLI
  explorer/   (later phase) static index, crawler, decider
  mcp/        (later phase) MCP server
  viewer/     (later phase) web viewer
zoo/
  shop/       Bug Zoo demo shop: Next.js + Postgres, standalone app with its own lockfile
  mock-pay/   mock payment provider: idempotent charges, signed webhooks, harness control
  cases/      one bug patch per case + expected results + verifier
```

## Development setup

Requirements: Node 22.18+ (`nvm use` picks Node 24), pnpm 10, Docker.

```sh
pnpm install                 # workspace packages
pnpm zoo:install             # the shop (standalone, own lockfile)
pnpm db:up                   # Postgres 17 on localhost:55432 (docker compose)
pnpm --dir zoo/cases exec playwright install --only-shell chromium
```

Checks:

```sh
pnpm typecheck
pnpm test                    # unit tests + branch integration test (needs pnpm db:up)
pnpm zoo:verify              # every Bug Zoo case against the clean shop and its bug variant
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

# Software Wind Tunnel — Execution Plan

## Tech stack

- **Language:** TypeScript (Node 22+), pnpm workspaces
- **Browser automation:** Playwright
- **Agent integration:** MCP TypeScript SDK (`@modelcontextprotocol/sdk`); plugins for Claude Code, Codex and Muse Code
- **Database:** Postgres (Docker)
- **Bug Zoo app:** Next.js + Postgres, mock payment provider
- **Viewer:** Vite + React
- **Accessibility checks:** axe-core
- **Models (development):** Claude Opus 5.5 (main) + Claude Haiku 5.5 (helper) via local Claude Code
- **Models (submission):** Muse Wonder 1.0 (main) + Muse Spark 1.3 (helper and quick decisions) via Meta Model API
- **Optional quick-decision model:** Jev (via `jev-use`)
- **Mac app (stretch):** Swift / SwiftUI
- **License:** MIT

---

## Phase 1 — Foundation

- [x] Monorepo scaffold: `core`, `explorer`, `mcp`, `viewer`, `cli`
- [x] Bug Zoo shop app (Next.js + Postgres) with seed data
- [x] Mock payment provider (checkout + controllable webhooks)
- [x] Bug Zoo cases 1–3: double submit, lost response + retry, duplicate webhook
- [x] Config file (`windtunnel.config.yaml`)
- [x] Isolated branches: git worktree per code version, Postgres copy per run, app pool, port allocation, cleanup

## Phase 2 — Experiment engine

- [x] Flows: deterministic Playwright scripts with named steps
- [x] Experiment file format
- [x] Rules file format + SQL rules checker
- [x] Browser perturbations: double submit, refresh, back + resubmit, second tab, expired session
- [x] Network perturbations: delay, 5xx, lost response after save, duplicate request
- [x] Fake clock
- [x] Ordered races: hold and release requests in a chosen order
- [x] Webhook control: duplicate, out of order, early
- [x] Second user
- [x] Database diff (row-level, before/after)
- [x] Repeat N times + flake rate
- [x] Run store
- [x] `windtunnel run` CLI

## Phase 3 — Agent connection + hunting

- [x] MCP server (7 tools: map, validate, run, evidence, branch, prove, decide; `decide` came with the Decider in Phase 5)
- [x] Shared skills: `init`, `hunt`, `prove`, `test`
- [x] Claude Code plugin with helper subagent
- [x] Codex plugin
- [x] Muse Code packaging
- [x] Evidence packets + drill-down
- [x] App map: static index (Next.js routes and handlers, Postgres schema)
- [x] Hunt loop: risky code patterns → experiments → findings (two blind tests: an agent with only the skill, map and CLI found the seeded oversell from its map flag, and four real bugs in the clean shop, now fixed and guarded by experiments)
- [x] Bug Zoo cases 4–7: early webhook, oversell, session expiry, lost update

## Phase 4 — Fix proof

- [x] Prover: patch in worktree, full matrix × N, revert check, regression set (other experiments + the project's test command on a fresh seed copy); proofs cached and reused
- [x] Branch output with regression experiments + `EVIDENCE.md` (`.windtunnel/evidence/<id>.md`, one commit on the base, working tree untouched)
- [x] Trace chain: request → handler file → SQL → row changes (Postgres wire proxy logs the app's statements; linked to requests by time window)
- [x] Re-test only what changed (affected experiments from recorded requests + the import graph, results reused by code version via `git diff`)
- [x] Bug Zoo prover check: `pnpm zoo:prove` proves every case's real fix and rejects a wrong fix

## Phase 5 — Efficiency layer

- [x] Crawler (page snapshot, rules mode): links only, as a visitor and test users, one `ariaSnapshotJSON` per page; real control names in the map, page locators by drill-down; cached per code version
- [x] Free sweep: console errors, failed requests, broken links, accessibility (axe-core), slow pages, during the crawl, 0 tokens
- [x] Decider: rules → Muse Spark (JSON schema, minimal reasoning) or Jev (OpenRouter Decisions API) → hand back to agent (`windtunnel_decide`, the seventh tool); redaction, confidence threshold, per-job budget
- [x] Selector repair (healed selector written back to the flow): candidates from the failure snapshot, every literal copy of the call rewritten, checked by a run without perturbations, experiment re-run; checks of what the page shows never healed by rules
- [x] Failure sorting: bug / flaky / outdated test / environment, with a run without perturbations to separate a broken flow from a perturbation-only failure
- [x] Usage meter + per-job budgets (tool output tokens per MCP session, Level 1 spend; meter line on run and prove)
- [x] Bug Zoo healing check: `pnpm zoo:heal` (renamed button and label healed and re-run; a changed confirmation, a real bug and a perturbation-only failure not healed)

## Phase 6 — Local API + viewer

- [x] Local API (HTTP + event stream): `windtunnel view`, JSON routes and server-sent events on 127.0.0.1 (session cookie or token, Host and Origin checks); the run store is polled, so runs from the CLI or an agent's MCP server show up as they start
- [x] Web viewer (Vite + React): runs grouped by batch, aligned timelines (steps lined up by tab and name on one clock, any runs side by side), first divergence (requests, then database writes), trace chain, DB diff, rule results, requests, page screenshots, logs, usage meter; evidence packets link to it while it runs
- [x] "Run hunt" button (`muse exec --json`, `hunt.command`): needs `MODEL_API_KEY`, never starts `claude` or `codex`, strips other providers' variables; reads JSONL without a fixed schema (Muse Code's isn't documented). Tested with a stand-in, not yet with Muse Code itself
- [x] "Open in Claude Code" button (`claude-cli://open?cwd=…&q=…`: prompt typed, not sent), in the header (hunt) and on each run (fix and prove)

## Phase 7 — Bug Zoo + benchmark

- [x] Bug Zoo cases 8–10: back + resubmit (orders unique per cart only while unpaid), another user's order (the status API skips the owner check), success before confirmation (the pay button says "Order confirmed" after 2.5 s and ignores a later failure). Cases 9 and 10 change no data, so rules can now read what users got and saw: `windtunnel_requests` and `windtunnel_pages`, temporary tables of the rule check. New perturbations: `replay-as` (the same request with another user's session) and `fail … after`. Evidence shows the first page that differs when the requests match; the map flags rows loaded by id with no owner in the query
- [x] Clean controls C1–C3: correct code that looks like cases 05, 03 and 09 (row lock, unique charge id, owner checked in code); `zoo:verify` requires every experiment to pass on them
- [x] Benchmark harness (`bench/`): one-commit trial folders outside the repo per case and setup (A: Playwright MCP; B: Wind Tunnel, rules only; C: + Muse Spark), Muse Code runner with HOME isolation and a time cap, scoring without a model (reproduce command fails with the bug and passes on the clean shop; hidden experiment on the final code; regressions; false alarms), manual trials for Claude Code. Real runs on Muse Wonder wait for the Muse setup (Phase 8)
- [x] Usage measurement per setup: host JSONL usage (tokens, cost or reported prices), Wind Tunnel's tool output and Level 1 spend, wall time
- [x] Scoreboard: totals per setup and a row per trial, written to `bench/results/<batch>/scoreboard.md`

## Phase 8 — Submission

- [ ] Muse setup: Muse Code host, Muse Wonder + Spark, `scripts/muse-env.sh`
- [ ] `npx windtunnel install`
- [ ] README with install steps + benchmark table
- [ ] Demo script + video

## Stretch

- [ ] S1 Proof gate (`Stop` hook)
- [ ] S3 Shrinking (minimal failing experiment)
- [ ] S4 Headless `claude -p` / `codex exec` with API keys
- [ ] S5 Cross-agent check
- [ ] S6 Express support
- [ ] S7 Visual fallback (Muse Spark on cropped screenshot)
- [ ] S8 Swift Mac app (menu bar, notifications, Run hunt, viewer window)

## Later (after the hackathon)

- [ ] Database-level pause points for races inside one handler
- [ ] OpenTelemetry tracing
- [ ] Proxy for calls from our server to other servers
- [ ] More stacks: Django, Rails, Laravel, Remix, SvelteKit; MySQL, SQLite
- [ ] Community experiment packs
- [ ] CI mode (GitHub Action)
- [ ] Reproduce a Sentry issue as an experiment
- [ ] Channels; Codex app-server; mobile apps
- [ ] Fully native Swift views in the Mac app

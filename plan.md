# Software Wind Tunnel — Plan

> **Your coding agent says it fixed the bug. Make it prove it.**
>
> Free, open-source, local experiments for web apps, run by the coding agent you already use: Muse Code, Claude Code or Codex.

Working name. Last updated 2026-10-28.

**Hackathon submission:** runs on Meta's models (Muse Wonder + Muse Spark) using the Meta Model API credits we were given. Open-source users bring their own agent and subscription. See §5.1.

---

## 1. What we're building

A local tool that works with the user's own Claude Code or Codex to:

1. **Find** bugs that only appear under real-world conditions: double clicks, lost responses and retries, duplicate webhooks, two users at once, sessions that expire mid-checkout.
2. **Reproduce** them on demand, with the same result every time, against the real backend and database.
3. **Trace** each bug from the screen to the request, the code and the rows changed in the database.
4. **Prove** a fix works: it passes every scenario, many times, and the bug comes back when the fix is reverted.

The output is a branch or PR with regression experiments and an evidence report, not a dashboard.

## 2. The problem

- **Bugs that matter don't reproduce by hand.** Races, retries and out-of-order webhooks happen 1 time in 50 and usually return "200 OK", so ordinary tests and crash detection miss them.
- **AI testing tools are slow and burn usage.** They send a model turn, often with a screenshot or full page dump, for every click in every run. Re-running the tests costs the same again.
- **Agents claim fixes without proof.** Root cause plus a suggested fix is common. Showing the fix actually works, across every ordering, is rare.

**Who it's for:** developers and small teams shipping web apps, especially code written with Claude Code or Codex. MVP stack: Next.js + Postgres.

## 3. Positioning

| Product | What it does | Where we differ |
|---|---|---|
| Replay QA | Explores the app, writes tests, recordings, root cause with confidence score, suggested fix | We inject failures, control ordering and prove fixes |
| Meticulous | Replays recorded sessions with backend responses faked | We use the real backend and database, which is where state and concurrency bugs live |
| Antithesis | Controls the whole machine; can branch a run and try alternatives | Enterprise and distributed systems. We're local, free and built for ordinary web apps |
| Playwright Test Agents | Plan, write and repair normal-path tests (open source) | No failures, no rules, no fix proof. We build on Playwright |
| Keploy, Tusk Drift | Record and replay API traffic with the database faked | Same difference as Meticulous |
| Sentry Seer | Root cause from production, handed to a coding agent | No reproduction step. We reproduce first |
| PlayerZero SIM-1 | A model *predicts* how code behaves | We run it |

**Technical thesis.** Most tools make runs repeatable by faking the backend, which hides the expensive bugs. Antithesis controls the whole machine, which is costly. We take the middle path: **a real backend and database, controlled at the edges**. That means database snapshots, request ordering, a fake clock and controlled webhooks.

**Don't claim** to be the first to branch a run (Antithesis does). **Do claim:** local, free, run by your agent, cheap on usage, with proof.

## 4. Principles

1. **The model decides; code does the work.** Plain code navigates, runs, waits, checks, compares and reports. The model only picks what to test, what "correct" means, why it failed and how to fix it.
2. **Experiments are files.** They can be re-run with no model involved, committed, and run in CI.
3. **Evidence over claims.** Every finding links to a run that reproduces it. Every fix links to a proof.
4. **Cheapest level first.** Plain code, then a small fast model (Muse Spark or Jev, optional), then the main agent. Within that, an API check is preferred over a browser check.
5. **Never touch the user's credentials.** The user's agent connects to us, not the other way round. The hackathon build runs on our own Meta API key.

## 5. How it connects to the user's agent

| Path | Use | Status |
|---|---|---|
| **Muse Code** (Meta's coding agent) + our MCP server and skills | Main path for the hackathon submission | MVP |
| **Claude Code plugin** (skills + MCP server + helper subagent + optional hook) | Main path for Claude users. Also the backup host for the submission: Claude Code pointed at Muse (§5.1) | MVP |
| **Codex plugin** (skills + the same MCP server) | Main path for Codex users | MVP |
| **"Run hunt" button** in the viewer (`muse exec --json`, billed to the Meta API key) | Start a hunt from the UI and stream progress live | MVP |
| **"Open in Claude Code" button** in the viewer (`claude-cli://` deep link) | Start a task from the UI with a Claude subscription | MVP |
| **Headless `claude -p` / `codex exec`** | Running from CI with no one at the terminal | Stretch. **API keys only**, never a subscription |
| **Channels** (push tasks into an open Claude Code session) | — | Later. Research preview; the Run button covers the demo |
| **Codex app-server** (UI drives Codex) | Full "app drives agent" for Codex | Later |

### 5.1 Hackathon submission setup (Meta models)

- **Host:** Muse Code. It supports MCP servers, `SKILL.md` skills, hooks (including `Stop`), subagents and headless `muse exec --json`. It also finds skills in `.claude/skills`, so **each skill is written once and serves all three hosts**.
  ```json
  { "mcp_servers": {
      "windtunnel": { "transport": "stdio", "command": "windtunnel", "args": ["mcp"] }
  } }
  ```
- **Models:**
  - `muse-wonder-1.0` (preview) runs the main loop: hunting, rules, root cause, patches.
  - `muse-spark-1.3` handles the helper subagent and Level 1 decisions (§10).
  - Reported prices per 1M tokens: Wonder $4 in / $20 out; Spark 1.3 $1.25 in / $4.25 out. Check Meta's pricing page.
- **Backup host:** Claude Code pointed at Muse, using Meta's documented settings. The plugin needs no changes:
  ```bash
  export ANTHROPIC_BASE_URL="https://api.meta.ai"        # no /v1
  export ANTHROPIC_AUTH_TOKEN="$MODEL_API_KEY"           # AUTH_TOKEN, not API_KEY
  export ANTHROPIC_MODEL="muse-wonder-1.0"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="muse-wonder-1.0"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="muse-spark-1.3"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="muse-spark-1.3"
  export CLAUDE_CODE_SUBAGENT_MODEL="muse-spark-1.3"
  export ENABLE_TOOL_SEARCH="true"
  ```
  Every model variable must point at a Meta model. Otherwise background tasks and subagents try to reach Claude models that Meta doesn't serve.
- **Running from the viewer:** usage is billed to our Meta key, so headless runs (`muse exec --json`) are fine. The viewer reads the JSONL event stream and shows it live.
- **Making credits last:**
  - Use Spark for development runs; save Wonder for the final benchmark and the demo.
  - Turn on prompt caching.
  - Cap each run with `--max-model-steps`.
  - Show credit spend on every job.
  - Don't use the cheaper "contributor" models: Meta trains on their prompts and outputs.

### 5.2 Development phase (before submission)

- **Build and test with local Claude Code on our own subscription.**
  - Write the code with Claude Code as usual.
  - Test the plugin in an interactive session with `claude --plugin-dir ./plugins/claude-code`, typing `/windtunnel:hunt` and similar commands by hand. This is ordinary use of Claude Code, so it's allowed.
- **Models during development: Claude 5 family**

  | Role | Development (Claude Code alias) | Submission (Meta) |
  |---|---|---|
  | Main loop: hunt, rules, root cause, patches | `opus` → Claude Opus 5.5 (Pro/Max default) | `muse-wonder-1.0` |
  | Helper subagent, routine leftovers | `haiku` → Claude Haiku 5.5 | `muse-spark-1.3` |
  | Optional cheaper main loop to save plan usage | `sonnet` → Claude Sonnet 5.5, or `opusplan` (Opus plans, Sonnet executes) | — |

  - **Use aliases (`opus`, `haiku`), never full model IDs, in plugin files** such as the helper subagent's `model: haiku`. The Meta environment variables map those same aliases to Muse models, so nothing changes at submission.
  - **Don't use `fable` (Fable 5.1)** for development. It can bill to usage credits instead of the plan's included limits.
  - **Opus 5.5 and Haiku 5.5 default to `medium` effort.** Set `effort: high` in the `hunt` and `prove` skills' frontmatter if their quality needs it.
- **Don't run `claude -p` from our own code on the subscription.** The viewer's Run button targets `muse exec` with the Meta key from the start. To test it cheaply, use Spark.
- **Keep the two setups in separate shells.** Put the Muse environment variables in `scripts/muse-env.sh` and source it only in a dedicated shell. If they leak into the normal shell, Claude Code silently sends requests to Meta. The reverse mistake can send a Meta key to Anthropic.
- **Check on Muse regularly, not just at the end.** Skills and prompts tuned on Claude can behave differently on Muse. Run the Bug Zoo smoke test on Muse (Spark) on days 0, 4, 6 and 9.
- **Use only Muse runs for the published numbers.** Claude runs during development don't count toward the benchmark.

**Compliance rules (non-negotiable)**
- Never read, store or forward Claude or ChatGPT credentials or tokens.
- Never call the Anthropic or OpenAI API with the user's login. The user's own unmodified CLI does all model work.
- Headless runs on Claude use an API key, never a Free/Pro/Max login.
- Don't use "Claude Code" or "Anthropic" in the product name or logo. Saying "works with Claude Code" in plain text is fine.

## 6. Architecture

```
  Host agent: Muse Code · Claude Code · Codex          (does all model reasoning)
    hackathon: Muse Wonder (main) + Muse Spark (helper) · open source: user's own login
        │  skills · MCP tools · helper subagent · optional Stop hook
        ▼
  windtunnel daemon (local, open source, TypeScript)
   ├─ App map      static index (routes, handlers, DB schema) + crawler (pages, forms, selectors)
   ├─ Decider      rules → Muse Spark or Jev (optional) → hand back to agent
   ├─ Branches     git worktree per code version · Postgres clone per run · app pool · ports
   ├─ Runner       Playwright flows · request routing (faults, hold/release) · fake clock ·
   │               second user · mock payment provider (controlled webhooks)
   ├─ Checks       SQL rules · screen checks · database diff · repeat N times / flake rate
   ├─ Run store    .windtunnel/runs/<id>/ : trace, request log, SQL log, DB diff, summary
   ├─ Evidence     short summary packets for the model + drill-down handles
   ├─ Prover       fix matrix · revert check · regression set · branch/PR output
   └─ Local API    HTTP + event stream: start hunts, list runs, fetch evidence, stream progress
                   (built: `windtunnel view` on 127.0.0.1, session token, polls the run store)
        │
        ├─ Web viewer (all platforms): aligned timelines, first divergence, trace chain, DB diff, usage meter
        └─ Swift Mac app (stretch): menu bar, notifications, Run hunt, viewer in a native window
```

**Design notes**
- **Faults with Playwright alone.** For browser-to-API requests, Playwright's request routing covers most MVP faults:
  - **Lost response after the server saved it:** `route.fetch()` runs the request on the server, then `route.abort()` tells the browser it failed.
  - **Delays and ordering:** await a barrier before fetching or fulfilling the request.
  - **Errors:** return a fake 5xx.

  A standalone proxy is only needed later, for calls from our server to other servers.
- **Webhooks are sent by the harness** through a small mock payment provider, so we fully control duplicates, order and timing.
- **Database copies:** `CREATE DATABASE run_x TEMPLATE base_y` per run, which is fast for seeded demo-size databases. Snapshot templates are built once from the seed.
- **App pool:** one built app process per code version and slot, with `DATABASE_URL` pointing at that run's copy. Default 4 in parallel.
- **Trace chain (MVP):**
  - **Request log:** request start and end come from Playwright routing.
  - **SQL log:** the app reaches Postgres through a small wire-protocol proxy that records each statement with its parameters, command tag, error, timing and connection. This works with any Postgres server and needs no server settings or log access (`log_statement=all` was the first idea).
  - **Handler file:** the URL and method map to a handler file through the static index.

  The harness runs steps one at a time, so time windows link each SQL statement to its request; where requests overlap (races), the evidence names every candidate rather than guessing, and transactions narrow it. The agent pinpoints the exact line by reading one handler file. OpenTelemetry comes later.

## 7. Core concepts

| Concept | Meaning |
|---|---|
| **Flow** | A deterministic Playwright script for a user journey (e.g. checkout), split into named steps |
| **Perturbation** | A controlled condition added to a flow: double submit, lost response, duplicate webhook, delay, second user, expired session, fake clock |
| **Rule (invariant)** | Something that must always be true, usually a SQL query that must return no rows ("at most one order per cart") |
| **Experiment** | Starting snapshot + flow + perturbations + rules + repeat count. A file in `.windtunnel/experiments/` |
| **Branch** | One isolated execution: code version (worktree) + database copy + app process |
| **Evidence packet** | A summary of at most about 2k tokens: rule broken, first divergence, requests, SQL, handler file, DB diff, with handles to drill down |
| **Proof** | Fails on the base code N/N times · passes on the patch N/N in every ordering · fails again when reverted · regression set green |

## 8. Features

### 8.1 MVP (hackathon)

| ID | Feature | Done when |
|---|---|---|
| F1 | **Config + init.** `windtunnel.config.yaml`; `/windtunnel:init` has the agent read the repo and write it (start/build commands, DB URL, seed, test users) | Zoo shop app initialised with one confirmation |
| F2 | **Isolated branches.** Worktree per code version, Postgres copy per run, app pool, port allocation, cleanup | 4 branches run in parallel without affecting each other |
| F3 | **Deterministic runner.** Flows, seeded data, fake clock, repeat N times, flake rate reported | The same experiment gives the same result 20/20 times |
| F4 | **Perturbations.** Browser: double submit, refresh, back then resubmit, second tab, expired session. Network: delay, 5xx, lost response after save, duplicate request. Webhooks: duplicate, out of order, early. Second user | Each perturbation triggers its Bug Zoo case |
| F5 | **Ordered races.** Hold requests at barriers and release them in a chosen order. Each ordering is a branch | The lost-response and two-tab cases reproduce 20/20 |
| F6 | **Rules.** SQL rules file; agent proposes, user approves; checked after every run | Rules catch every Bug Zoo case where the database is wrong |
| F7 | **Database diff.** Row-level before/after diff per table, keyed by primary key | Diff shows "2 rows in orders" for the duplicate case |
| F8 | **Run store + evidence packets.** Full artifacts on disk; the model gets a short packet plus drill-down handles | Median packet ≤ 2k tokens |
| F9 | **App map.** Static index (Next.js routes and handlers, Postgres schema) + rules-mode crawler (pages, forms, stable selectors) | Map summary ≤ 3k tokens; built with 0 model tokens |
| F10 | **Hunt loop.** Agent scans the code for risky patterns (unprotected POSTs, check-then-act, webhooks without dedupe, multi-row writes outside a transaction) → writes experiments → runs → reports | Finds Bug Zoo cases from code + map, without blind clicking |
| F11 | **Fix proof.** Patch in a worktree → full matrix × N → revert check → regression set (other experiments + the project's test command) → branch with regression experiments + `EVIDENCE.md` | Proof passes for real fixes and fails for a deliberately wrong fix |
| F12 | **Re-test only what changed.** Record which handlers and files each experiment touches; after an edit, run only those; cache results by code hash | Editing one handler re-runs only its experiments, with 0 tokens |
| F13 | **MCP server + host packaging.** ≤ 7 tools, short descriptions. Skills written once and packaged for Muse Code (settings snippet), Claude Code (plugin with helper subagent) and Codex (plugin) | The same hunt works in Muse Code and in Claude Code pointed at Muse; Claude Code plugin's fixed context cost is under 300 tokens |
| F14 | **Decider + repair + triage.** Ambiguous small decisions go to rules, then Muse Spark or Jev (whichever key is set), then back to the agent. Used for crawling, fixing broken selectors (healed selector written back to the file) and failure sorting (bug / flaky / outdated test / environment) | Works with no extra key; with Spark or Jev, fewer decisions reach the main model |
| F15 | **Viewer.** Runs list, branch timelines aligned by step, first divergence highlighted, trace chain, DB diff, rule results, usage meter, "Open in Claude Code" button | The demo can be presented from the viewer alone. **Built:** `windtunnel view` ([docs/viewer.md](docs/viewer.md)) |
| F16 | **Usage meter + budgets.** Count the tokens of everything our tools return; per-job budget; Jev cost shown | Meter appears on every job |
| F17 | **Free sweep (no model).** Console errors, failed requests, broken links, accessibility (axe-core), slow pages, found during the crawl | Runs as part of the map step at 0 tokens |
| F18 | **Bug Zoo + benchmark** (see §11) | Scoreboard for 3 setups committed to `bench/results/`. **Built:** cases 1–10 and controls C1–C3; `bench/` prepares one-commit trials outside the repo, runs Muse Code headless, and scores without a model (found = a reproduce command that fails with the bug and passes on the clean shop; fixed = the hidden experiment passes on the final code) |
| F19 | **Run from the viewer.** A "Run hunt" button starts `muse exec --json` with the Meta key and streams its events into the viewer | The demo starts from the viewer with one click. **Built:** command in `hunt.command`; events read without a fixed schema, since Muse Code's isn't documented |

### 8.2 Stretch (only if MVP is done)

- S1 **Proof gate:** an opt-in `Stop` hook (Muse Code and Claude Code both support it). When the session edited files covered by experiments, it runs the affected experiments and blocks "done" until they pass.
- S3 **Shrinking:** reduce a failing experiment to the fewest steps and the smallest delay that still fail.
- S4 **Headless `claude -p` / `codex exec`** for CI, using API keys.
- S5 **Cross-agent check:** with two hosts available, one writes the fix and the other tries to write an experiment that breaks it.
- S6 **Express support** in the static index.
- S7 **Visual fallback:** when the DOM can't answer a screen check, ask Muse Spark about a cropped screenshot.
- S8 **Swift Mac app (thin client, ~1 day):**
  - Menu-bar item with run status and notifications.
  - A "Run hunt" action and the viewer in a native window (`WKWebView`).
  - It uses the daemon's local API and contains no logic of its own.
  - Promote it to MVP if we want a native Mac moment in the demo.

### 8.3 Later (after the hackathon)

- Database-level pause points, so races *inside* one handler (between a SELECT and an UPDATE) become deterministic.
- OpenTelemetry / sqlcommenter tracing in place of time-window correlation.
- Proxy for calls from our server to other servers (third-party APIs).
- More stacks: Django, Rails, Laravel, Remix, SvelteKit; MySQL and SQLite.
- Community **experiment packs** (e.g. `stripe-webhooks`, `nextauth-session-expiry`, `prisma-oversell`).
- CI mode (GitHub Action) running affected experiments on every PR.
- "Reproduce this Sentry issue": turn a production error into a reproducing experiment.
- Channels (push tasks into an open Claude Code session); Codex app-server integration; mobile apps.
- Fully native Swift views in the Mac app, replacing the embedded web viewer.

### 8.4 Out of scope

Linux or host troubleshooting, spatial/XR canvas, hosted cloud service, testing against production, open-ended support for any stack.

## 9. User workflows

1. **Install:** `npx windtunnel install` sets up whichever hosts it finds (Muse Code, Claude Code, Codex) and checks Docker, Postgres and Playwright browsers.
2. **Init:** `/windtunnel:init`. The agent reads the repo, writes `windtunnel.config.yaml`, builds the seed snapshot and the app map, and runs the free sweep. **One confirmation.**
3. **Hunt:** `/windtunnel:hunt checkout`.
   - The agent reads the map, flags risky code and proposes rules plus experiments in **one approval**.
   - Experiments run in parallel; the agent gets evidence packets.
   - The report lists each confirmed bug with a reproduction and a viewer link.
4. **Prove:** `/windtunnel:prove <bug>`. The agent writes a patch in a worktree, runs the proof matrix, and opens a branch/PR with regression experiments and `EVIDENCE.md`. Nothing touches the working tree without approval.
5. **Re-test:** `/windtunnel:test`, or watch mode. Only affected experiments run, with 0 tokens.

## 10. Efficiency design

**Where competitors lose usage and time:** one model turn per click; page dumps or screenshots in context (a 1280×800 screenshot is about 1.4k tokens); re-running through the model; re-discovering the app every session; runs one after another; constant permission prompts.

**Decision levels**

```
Level 0  plain code   run, wait, check, compare, minimise, report        free · ms
Level 1  small model  pick-one / yes-no / rating decisions               Muse Spark (structured output, minimal reasoning)
                                                                         or Jev (~230 ms, ~$0.02 per 1k, reported)
Level 2  main agent   hypotheses, rules, root cause, fixes               Muse Wonder (submission) or the user's own agent
         (routine leftovers go to the helper subagent: Muse Spark, or Haiku on Claude)
```

The daemon calls a Level 1 model only with a key we configure (Meta or Jev). It never calls the user's subscription. When Level 1 isn't confident, the decision goes back to the agent in a tool result, and the agent answers with `windtunnel_decide`.

**Built (Phase 5):** decisions are multiple choice: which candidate a broken locator meant (selector repair) and how to sort a failure (bug / flaky / outdated test / environment). Rules answer first; `decider.confidence` (0.8) decides when an answer is good enough; `budget.usd` caps Level 1 spend per job; `WINDTUNNEL_DECIDER=rules|spark|jev|auto` picks the level (setups B and C of the benchmark). Passwords from the config, keys and connection strings are removed from a question before it leaves the machine.

**Muse Spark as Level 1 (submission default):** `POST https://api.meta.ai/v1/chat/completions` with `MODEL_API_KEY`, a JSON schema for the answer (`response_format: json_schema`, `{choice: enum, confidence}`) and `reasoning_effort: "minimal"`; cost from the reported prices. Measure latency against Jev in the benchmark.

**Jev (optional alternative)**
- **What it is:** TypeSafe's decision model. It returns typed answers with confidence and writes no text. It's hosted only and needs a TypeSafe, OpenRouter or Vercel key. **Built:** called through OpenRouter's Decisions API (`POST https://openrouter.ai/api/alpha/decisions`, model `typesafe/jev-1.14`, a `choice` question; `OPENROUTER_API_KEY`), which returns the choice, its confidence and the cost.
- **Used for:** choosing the next crawl action (action and target in one request), repairing selectors, checking screens ("is a confirmation visible?"), sorting failures, and trimming evidence.
- **Never used for:** writing tests, rules or fixes. Form values come from code (generated from the field type).
- **Code we planned to reuse, and what we did instead:**
  - [jev-use](https://github.com/shitianfang/jev-use) (MIT) offers `check` / `pick` / `rate`, escalation and redaction. We call the Decisions API directly (one small request), with our own redaction and escalation, so there is no extra dependency.
  - The page-snapshot approach from [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (one browser call per snapshot, a list of controls): Playwright now ships this as `page.ariaSnapshotJSON()` (about 10 ms a page, only visible elements, the same accessible names `getByRole` matches), so we use that and copy no code.
- **Behind an interface:** a `LevelOne` interface inside the `Decider`, so Jev or Spark can be removed without changes elsewhere.

**Targets (to measure, not claims)**

| Metric | Target |
|---|---|
| Model tokens to re-run an experiment | 0 |
| Plugin fixed context cost | < 300 tokens |
| MCP tools exposed | ≤ 7 |
| Tool result size | median ≤ 2k tokens, hard cap 4k with drill-down |
| Model turns to write one flow | ≤ 4 |
| Model tokens to build the app map (rules mode) | 0 |
| Model tokens per proven fix vs baseline (same model) | ≥ 5× fewer (hypothesis to test in §11) |

**Saving the user's time:** parallel branches, background runs with a notification when done, one approval per hunt, re-running only what changed, and a one-screen report.

## 11. Bug Zoo and benchmark

The one idea kept from the Linux-agent proposal: **an eval set with known answers.**

**What it is:** one demo shop (Next.js + Postgres + mock payment provider) in 13 variants. Ten each contain one seeded bug written the way real code goes wrong, and three are clean controls. Every variant is a git branch under `zoo/`.

| # | Case | Perturbation | Rule that catches it | Correct fix |
|---|---|---|---|---|
| 1 | Double submit | Double click "Pay" | At most one order per cart | Idempotency key + unique constraint |
| 2 | Lost response, user retries | Response dropped after save; user clicks Pay again | One order per cart; one charge per order | Same idempotency key reused on retry |
| 3 | Duplicate webhook | Payment webhook delivered twice | One payment record per order | Dedupe on webhook event id |
| 4 | Early webhook | Webhook arrives before the order row is saved | No order left "pending" after payment success | Handle out-of-order states (upsert) |
| 5 | Oversell | Two buyers released together for the last item | Stock ≥ 0; orders ≤ initial stock | Conditional `UPDATE … WHERE stock > 0` |
| 6 | Session expires mid-checkout | Session cookie cleared before Pay | No order without a user; cart kept after re-login | Re-auth flow preserves cart; server checks owner |
| 7 | Lost update | Two tabs edit the same product | No silent overwrite | Version column (optimistic locking) |
| 8 | Back and resubmit | Back after payment, submit again | At most one order per cart | Redirect after POST + idempotency |
| 9 | Another user's order (IDOR) | Second user requests order IDs that aren't theirs | Users can only read their own orders | Ownership check |
| 10 | Success before confirmation | 3 s delay, then error on POST | Confirmation shown ⇒ order row exists | Wait for the server before showing success |
| C1–C3 | Clean controls | All of the above | — | Any finding counts as a false alarm |

**Scoreboard columns:** found · reproduced (N/N) · correct handler file · fix proven · false alarms · model tokens · credits spent (Meta, plus Jev if used) · wall time.

**Scoring (built, no model):** the task asks for `bench-report.json` with a reproduce command per finding. *Found* = that command fails with the bug and passes on the clean shop (the only difference between them is the seeded bug). *Fix proven* = the case's hidden experiment passes in every run on the agent's final code; the other hidden experiments give regressions. *False alarms* = any finding on a control; on a bug case, a command that never fails with the bug. Bugs that change no data (cases 9, 10) are caught by rules on `windtunnel_requests` and `windtunnel_pages`.

**Setups compared (all on Muse Wonder, same time cap, same task prompt)**
- **A.** Muse Code + Playwright MCP, no Wind Tunnel: "Find and fix bugs in checkout. Prove each fix."
- **B.** Muse Code + Wind Tunnel, rules only.
- **C.** Muse Code + Wind Tunnel + Muse Spark at Level 1 (add a Jev row if time allows).

Comparing on the same model makes the result about the tool, not the model. One extra row runs Wind Tunnel in Claude Code to show it works with other hosts.

**Running it:** everything is billed to the Meta key. Measure exact usage per setup; on day 0, check which works: a separate API key per setup with Meta's usage page, or `muse export --session`. Scripts and raw results are committed in `bench/`. The Bug Zoo also becomes the project's CI, so changes can't quietly make the tool worse.

## 12. Demo script (~3 minutes)

1. **Hook (15 s):** "Agents say they fixed it. Here's what proof looks like, running on Meta's Muse models."
2. **Hunt (60 s):** click **Run hunt** in the viewer. Muse Code (Muse Wonder) starts on the shop, and its progress streams into the viewer.
   - The agent flags an unprotected `POST /orders`, a webhook handler without dedupe, and check-then-act stock code.
   - It proposes 3 rules, which get one approval.
3. **Experiments (45 s):** four branches start from the same snapshot (normal · lost response then retry · duplicate webhook · two buyers for the last item). Three turn red: 2 orders for 1 cart, a double charge, stock −1. The viewer shows the first divergence and the chain from the second request to `orders.ts` to the second INSERT.
4. **Proof (45 s):** the agent patches in a worktree.
   - Every ordering passes 20 times: green.
   - Reverting the patch: red again.
   - A branch with regression experiments and `EVIDENCE.md` is opened.
5. **Efficiency (15 s):** the Bug Zoo scoreboard for A, B and C, showing tokens and time per proven fix.

## 13. Ten-day schedule

Assumes two people: **H** (harness and runner) and **A** (agent, plugin and viewer). If solo, cut in this order: S-items → F15 extras → Jev backend (keep Muse Spark) → F17 → Codex packaging.

| Day | H (harness) | A (agent + UI) |
|---|---|---|
| 0 (half day) | Confirm submission rules and credit amount | Meta key; Muse Code with a test MCP tool and skill; Claude Code pointed at Muse as backup; how to measure usage per run |
| 1 | Repo scaffold (pnpm, TypeScript); Docker Postgres; template copies; app pool | Zoo shop app (Next.js + Postgres + mock payment provider), seed; cases 1–3 |
| 2 | Playwright runner; flows and steps; request routing (delay, 5xx, lost response, duplicate); run store | Config format + `init` skill draft; flow and experiment file formats |
| 3 | Rules checker; DB diff; repeat N + flake rate; `windtunnel run` CLI | Hand-written experiments for cases 1–3 turn red; static index (routes, handlers, schema) |
| 4 | Barriers + ordered release; second user; expired session; fake clock | MCP server (tools); shared skills; packaging for Muse Code, Claude Code and Codex; Muse smoke test |
| 5 | Webhook control (duplicate, out of order, early); SQL log + trace chain | Hunt loop: risky patterns → experiments → evidence packets; cases 4–7 |
| 6 | Prover: worktree patch, matrix, revert check, regression set, branch output | Prove skill; `EVIDENCE.md` template; re-test only changed; Muse smoke test |
| 7 | Crawler (snapshot approach, rules mode); free sweep (axe, console, requests) | Decider (rules, Muse Spark, Jev, hand back); selector repair; failure sorting |
| 8 | Hardening: cleanup, ports, timeouts, flaky-run handling | Viewer: aligned timelines, first divergence, trace chain, DB diff, meter, Run hunt button (`muse exec --json`), deep link |
| 9 | Cases 8–10 + controls C1–C3; benchmark harness | Run benchmark A/B/C; fix the worst misses; stretch S1/S7 if time allows |
| 10 | README, install script, licence | Demo rehearsal, video, scoreboard in README |

## 14. Tech stack and repo layout

**Language choice**
- **Core (daemon, runner, MCP server): TypeScript (decided 2026-10-28).** Python was the alternative: it has official Playwright and MCP SDKs too. TypeScript won because:
  - **Playwright's primary language is TypeScript.** Its test runner, fixtures, parallel workers and test agents are Node-only.
  - **Parsing Next.js routes and handlers needs real TS/TSX parsing.** The TypeScript compiler API does this natively; Python would need tree-sitter.
  - **One language for the core, viewer (React) and Bug Zoo app (Next.js).** That means shared schemas between the local API and the viewer, and one toolchain.
  - **Easy install for web developers:** they already have Node, so `npx windtunnel install` works with no Python setup.
  - **The MCP TypeScript SDK is the reference implementation.** Agent plugins usually launch MCP servers with `npx`.
- **Not Swift for the core.** Playwright has no Swift API, and the core must run on Mac, Linux, Windows and in CI.
- **Swift Mac app: yes, as a client.** The daemon exposes a local API (HTTP + event stream). The web viewer and the Swift app both use that API, so the logic lives in one place. See S8.

**Stack:** Node 22+, TypeScript, pnpm workspaces · Playwright · `@modelcontextprotocol/sdk` · Postgres in Docker · Next.js (Bug Zoo app) · Vite + React (viewer) · SwiftUI (Mac app, stretch) · axe-core · OpenAI SDK pointed at `https://api.meta.ai/v1` (Muse Spark decider) · `jev-use` (optional dependency) · MIT licence.

```
packages/
  core/       config, branches (worktree, PG copy, app pool, SQL log proxy), runner, perturbations, rules, DB diff,
              run store, evidence + trace chain, prover + proof branches
  explorer/   static index, affected experiments, crawler, Decider (rules / jev / handback), free sweep
  mcp/        MCP server (tools below)
  viewer/     local web UI
  cli/        `windtunnel` CLI: install, init, run, view, bench
plugins/
  windtunnel/   one plugin folder for Claude Code and Codex: skills/ (init, hunt, prove, test: written
                once), .claude-plugin/plugin.json + .mcp.json (Claude Code), plugin.json + mcp.json (Codex),
                agents/windtunnel-helper.md (model: haiku), hooks/ (opt-in proof gate, later)
  muse-code/    settings snippet (mcp_servers); skills copied from plugins/windtunnel/skills
                with a prefix (`windtunnel skills --out .agents/skills --prefix windtunnel-`)
apps/
  mac/          SwiftUI menu-bar app (stretch S8), a client of the daemon's local API
zoo/
  shop/       Next.js + Postgres demo shop
  mock-pay/   mock payment provider (checkout + controllable webhooks)
  cases/      one branch/patch per case + expected results
bench/        benchmark harness, prompts, results/
docs/
plan.md
```

## 15. File formats (draft)

**`windtunnel.config.yaml`**
```yaml
app:
  build: pnpm build
  start: pnpm start --port $PORT
  test: pnpm test             # optional: part of every proof's regression set
  baseUrl: http://localhost:$PORT
  env:
    DATABASE_URL: $DATABASE_URL
    PAYMENT_API_URL: $MOCK_PAY_URL
db:
  kind: postgres
  url: postgres://postgres:postgres@localhost:5432/shop
  seed: pnpm db:seed          # builds the template snapshot once
users:
  alice: { email: alice@example.test, password: test }
  bob:   { email: bob@example.test,   password: test }
parallel: 4
crawl: { users: [alice], maxPages: 40 }   # optional; slowPageMs, slowRequestMs, skip
decider: { use: auto, confidence: 0.8 }   # auto: Muse Spark if MODEL_API_KEY, else Jev if OPENROUTER_API_KEY, else rules
budget: { tokens: 150000, usd: 0.5 }      # per job: tool output (warn past it), Level 1 spend (then hand back)
```

**Flow:** `.windtunnel/flows/checkout.ts`
```ts
import { flow } from "windtunnel";

export default flow("checkout", async ({ page, as, step }) => {
  await as("alice");
  await step("add-item", () => page.getByRole("button", { name: "Add to cart" }).first().click());
  await step("open-cart", () => page.getByRole("link", { name: "Cart" }).click());
  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());
  await step("confirmation", () => page.getByText("Order confirmed").waitFor());
});
```

**Experiment:** `.windtunnel/experiments/checkout-lost-response.yaml`
```yaml
id: checkout-lost-response
flow: checkout
start: snapshot:seed
perturb:
  - at: { step: pay, request: "POST /api/orders" }
    do: drop-response-after-commit
  - on: network-error
    do: { repeat-step: pay }
rules: [one-order-per-cart, one-charge-per-order]
repeat: 20
```

**Rules:** `.windtunnel/rules.yaml`
```yaml
one-order-per-cart:
  sql: SELECT cart_id FROM orders GROUP BY cart_id HAVING count(*) > 1
  expect: empty
stock-non-negative:
  sql: SELECT id FROM products WHERE stock < 0
  expect: empty
```

## 16. Agent-facing surface

**MCP tools (≤ 7)**

| Tool | Returns |
|---|---|
| `windtunnel_map` | Compact app map: routes → handlers, tables, flows, rules, free-sweep findings |
| `windtunnel_validate` | Checks an experiment, flow or rules file without running it |
| `windtunnel_run` | Runs experiments by id or `affected`; returns a compact result table |
| `windtunnel_evidence` | Evidence packet for a run; drill-down by handle (step, request, SQL, diff) |
| `windtunnel_branch` | Creates an isolated branch from a code ref or patch plus a snapshot |
| `windtunnel_prove` | Proof matrix result: base / patch / revert / regression |
| `windtunnel_decide` | Answers a decision the daemon handed back (selector, triage); without an id, lists the open ones |

**Skills:** `init`, `hunt`, `prove`, `test`, shared by all hosts. **Subagent:** `windtunnel-helper` for routine leftovers (Muse Spark in the submission, Haiku on Claude). **Hook (opt-in):** Stop proof gate.

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Subscription policy changes again | Plugin-first; no credentials; headless only with an API key |
| Muse Wonder is in preview; Muse Code is new | Claude Code pointed at Muse is a documented backup (§5.1), with the same skills and MCP server |
| Credits run out or hit rate limits | Spark for development, Wonder for final runs, prompt caching, step caps, meter on every job |
| Jev is new, its API is "alpha", and it needs a key | Optional, behind `Decider`; rules and Muse Spark cover the same decisions |
| Runs not repeatable (timers, random IDs, outside calls) | Database copies, fake clock, harness-controlled webhooks and payments, repeat N with flake rate shown |
| App startup per branch is slow | Build once per code version; warm app pool |
| Seeded bugs look fake | Model them on real bug reports; include clean controls |
| Benchmark seen as unfair | Same model, prompt and time cap; publish scripts and raw output |
| Scope creep | Section 8.4 is binding; stretch items only after the MVP checklist is done |

## 18. Success criteria

- Bug Zoo: **≥ 8/10 found and reproduced 20/20**, **≥ 7/10 fixes proven**, **0 false alarms** on controls (setup B).
- Every efficiency target in §10 measured and published, including where we miss.
- A new user gets from install to first hunt on the shop in under 10 minutes.
- Demo runs end to end without manual fixes.

## 19. Open questions

1. Submission date, judging criteria, and how many Meta credits we have.
2. Final product name (and CLI name: `windtunnel`?).
3. Team size: is the plan for two people right?
4. Licence: MIT (recommended) or Apache-2.0?

## 20. References

- Anthropic — [Claude Code legal & compliance](https://code.claude.com/docs/en/legal-and-compliance), [run programmatically](https://code.claude.com/docs/en/headless), [channels](https://code.claude.com/docs/en/channels.md), [plugin cost](https://code.claude.com/docs/en/plugins/measure.md)
- OpenAI — [Codex harness / app-server](https://openai.com/index/unlocking-the-codex-harness)
- Meta — [models](https://dev.meta.ai/docs/models), [coding agents setup](https://dev.meta.ai/docs/coding-agents), [Muse Code](https://dev.meta.ai/docs/muse-code), [extending Muse Code](https://dev.meta.ai/docs/muse-code/extending)
- Landscape — [Replay QA](https://www.replay.io/replay-qa), [Meticulous](https://www.meticulous.ai/), [Antithesis multiverse debugging](https://antithesis.com/docs/multiverse_debugging), [Playwright Test Agents](https://playwright.dev/docs/test-agents), [Keploy](https://keploy.io/docs/concepts/what-is-keploy.md), [Sentry Seer](https://docs.sentry.io/product/ai-in-sentry/seer/autofix), [PlayerZero SIM-1](https://playerzero.ai/resources/sim-1-code-simulations)
- Jev — [OpenRouter Jev guide](https://openrouter.ai/docs/guides/community/jev.md), [jev-use](https://github.com/shitianfang/jev-use), [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
- Token efficiency — [Playwright CLI vs MCP](https://morphllm.com/playwright-mcp), [re-test](https://dev.to/aswani25/playwright-cli-vs-playwright-mcp-which-should-you-use-with-claude-code-1olh)

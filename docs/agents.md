# Using Wind Tunnel from a coding agent

Wind Tunnel does no model work itself. Your agent (Claude Code, Codex or Muse Code) does the
thinking; Wind Tunnel gives it a map of the app, runs experiments, and answers with short
evidence. Everything an agent can do also works from the CLI.

## Install

```sh
npx windtunnel-cli install        # or, from a checkout: pnpm wt install
```

It checks Node, git, Docker, Postgres and Playwright's Chromium, installs the CLI globally (so
`windtunnel` is on `PATH` for the skills), and adds the plugin to each agent it finds, after
one confirmation (`--yes` skips it, `--dry-run` only shows it, `--hosts claude,codex,muse`
limits it):

| Agent | What it does |
|---|---|
| Claude Code | `claude plugin marketplace add <package>`, `claude plugin install windtunnel@windtunnel` |
| Codex | `codex plugin marketplace add <package>`, `codex plugin add windtunnel@windtunnel` |
| Muse Code | skills in `~/.agents/skills/windtunnel-*`, the MCP server in `~/.config/muse/settings.json` (other settings kept, a backup made); see [`plugins/muse-code`](../plugins/muse-code/README.md) |

The marketplaces point at the installed package (or this checkout), so the plugin matches
the CLI's version. Running it again is safe. By hand instead:

```sh
claude --plugin-dir ./plugins/windtunnel              # Claude Code, from a checkout
/plugin marketplace add Divyendra-S/msa               # or from this repository (default branch)
/plugin install windtunnel@windtunnel
codex plugin marketplace add Divyendra-S/msa          # Codex
codex plugin add windtunnel@windtunnel
```

The plugin in [`plugins/windtunnel`](../plugins/windtunnel) works in Claude Code and Codex: four
skills, an MCP server and (Claude Code) a helper subagent. Muse Code reads the same skills.

The MCP server is `windtunnel mcp`. Without `windtunnel` on `PATH`, the Claude Code plugin
starts the CLI next to it (in the npm package or a checkout), finding Node 22.18+ through nvm
if the default `node` is older. It finds `windtunnel.config.yaml` in the current folder, a
parent, or (when there is exactly one) a subfolder up to three levels down. Codex starts a
plugin's server in the plugin's folder; the server then starts from the session's folder
(`PWD`) instead.

Fixed context cost in Claude Code: about 255 tokens (skill and agent descriptions; MCP tool
schemas load on demand). Check with `claude --plugin-dir ./plugins/windtunnel plugin details windtunnel`.

## Skills

| Skill | What the agent does |
|---|---|
| `init` | Reads the repo, writes `windtunnel.config.yaml` and a login flow after one confirmation, validates, maps and crawls the app (with the free sweep) |
| `hunt` | Reads the map, turns flagged code patterns into hypotheses, writes rules and experiments after one approval, runs them, confirms bugs with evidence, reports each with a reproducing run |
| `prove` | Fixes a reproduced bug, proves the fix with `windtunnel_prove`, and (with the user's yes) makes a branch with the fix, regression experiments and evidence |
| `test` | Re-runs only the experiments the code changes affect; reports the failure sorting (healed flows included), answers handed-back decisions, reads evidence only for bugs |

In Claude Code they are `/windtunnel:init`, `/windtunnel:hunt checkout`, and so on. The
`windtunnel-helper` subagent (Haiku on Claude, Muse Spark on Muse) handles routine
follow-ups: validating, re-running, summarising evidence, answering obvious decisions.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `windtunnel_map` | `focus?`, `crawl?` | The app map (below), under about 3k tokens; with `crawl`, first runs the app and crawls it (live crawl and free sweep) |
| `windtunnel_validate` | `experiments?` | `ok`, or every problem in config, flows and experiments, plus rules that error or already break on the seed data |
| `windtunnel_run` | `experiments?`, `affected?`, `repeat?`, `ref?`, `patch?` | Result table: outcome per experiment and ordering, rules broken N/N, run ids; with `affected`, which results were reused and why the rest ran; then the failure sorting (healed flows, re-runs, decisions for the agent) and the usage line |
| `windtunnel_evidence` | `handle` | Evidence packet for a run id, or one detail: `<run>/<n>/steps`, `requests`, `sql`, `sql:<table>`, `trace`, `diff`, `diff:<table>`, `rule:<id>`, `page`, `log`, `console`, `webhooks`; or `crawl`, `crawl:<path>`, `sweep`, `usage`, `decisions` |
| `windtunnel_branch` | `action` (`start`/`list`/`stop`), `ref?`, `patch?`, `id?` | A running copy of the app with its own database and mock payments, to try things by hand |
| `windtunnel_prove` | `experiments`, `base?`, `patch?`, `repeat?`, `branch?`, `message?` | The proof matrix and a verdict; with `branch`, the branch it created |
| `windtunnel_decide` | `id?`, `answer?` | Open decisions Wind Tunnel handed back; with `id` and `answer`, applies the answer (a selector is written into the flow file and checked with a run) |

`patch` is a unified diff or the path to one. Long runs send MCP progress notifications
when the client asks for them.

## The app map

Built from the code in about 50 ms, plus the schema from a copy of the seed snapshot, plus
the latest live crawl (below): no model.

```
POST /api/orders  app/api/orders/route.ts
  auth:getCurrentUser · getOpenCart→SELECT carts · getCartItems→SELECT cart_items+products · tx{ INSERT orders ON CONFLICT (cart_id) DO NOTHING · SELECT orders · UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1 · INSERT order_items } · createCharge→fetch POST /v1/charges [idempotency key: optional] · UPDATE orders SET status = 'processing', charge_id = $2 WHERE id = $1 AND status = 'pending'
  ! UPDATE orders after an external call
```

- **Routes:** Next.js App Router route handlers (route groups, `[id]`, catch-alls), Pages
  Router API routes, and `"use server"` modules.
- **Effects, in order:** SQL in string and template literals, Prisma (`prisma.order.create`)
  and Drizzle (`db.update(products)`) calls, `fetch`, transactions (`tx{…}`), and local helpers
  followed through imports (relative and tsconfig `paths`) up to three calls deep. Helpers named
  like auth or session checks show as `auth:<name>`.
- **Flags (`!`):** hints for experiments, not findings (`✓` marks a guard it saw, such as
  webhook dedupe): check-then-act (read a table, then
  an unconditional write to it), a transaction that works from rows read before it began, blind UPDATE/DELETE (WHERE only picks the row), writes after an
  external call, INSERT with no ON CONFLICT on a table with no natural unique key, two or more
  writes outside a transaction, external POSTs without an idempotency key, mutating handlers
  with no auth or signature check, webhooks with or without event-id dedupe, session
  lookups with no expiry check, and logged-in routes that load a user's row by the id in the
  path with no owner column (a foreign key to users, `user_id`, `owner_id`) in the query: try
  `replay-as`.
- **Pages:** buttons, form labels, short texts the page can show (what a flow waits for:
  "Order confirmed", "Payment failed"), the requests its components send, and whether the
  page redirects to log in.
- **Comments:** the first line of the comment above each handler.
- **Database:** tables with keys, foreign keys, unique constraints (partial ones too), enum-like
  checks, defaults and seed row counts.
- **Wind Tunnel files:** users, flows with their steps and params, rules, experiments.

`focus` keeps routes and pages whose path, file, handler comment, effects (tables,
requests) or page text contain it; when nothing matches, the map says so and lists the
routes and pages. `windtunnel map` prints the same thing (`--no-schema` skips the build and
database).

## Live crawl and free sweep

`windtunnel_map` with `crawl: true` (CLI: `windtunnel crawl`, or `map --crawl`) starts a copy
of the app and visits it as an anonymous visitor and as test users (`crawl.users`, default the
first user, logged in with `flows/login.ts`). It follows links only: no form is submitted and no
button pressed, and the copy has its own database anyway. It starts from `/` and every page
route without parameters, visits at most two pages per route and `crawl.maxPages` (40) per
user, and skips logout links. Each page costs one accessibility-tree snapshot (about 10 ms),
so the shop's 17 pages as three users take 17 s, most of it starting the app.

```
Live crawl (version 5b1f0a08c0e5, 17 pages as anonymous, alice, sam, 17.2 s): controls as getByRole sees them
/cart → /login?next=/cart (anonymous, 200)  textbox "Email" · textbox "Password" · button "Log in" · 2 links
/admin/products/1 (sam, 200)  button "Log out" · textbox "Name" · textbox "Description" · spinbutton "Price in cents" · button "Save" · 4 links
free sweep: nothing found (console, requests, links, accessibility, speed)
```

The map shows the newest crawl unless files of the app changed since (it then says so).
`windtunnel_evidence` with `crawl:/cart` gives one page with a ready-made locator per control
(`page.getByRole("button", { name: "Add to cart" }).nth(1)`, `exact: true` where a name is a
prefix of another); `crawl` lists every page.

The **free sweep** runs during the crawl, with no model: console errors and uncaught
exceptions; same-origin requests that failed or answered 4xx/5xx; links to pages that answer
4xx/5xx (unvisited ones are checked with a plain request; a 4xx on a page the user has no link
to is access control, not a finding); accessibility problems from axe-core (WCAG 2.0/2.1 A and
AA, once per route and user); pages slower than `crawl.slowPageMs` (2 s) and API calls slower than
`crawl.slowRequestMs` (1 s). Findings are grouped across pages and users; `windtunnel_evidence`
with `sweep` lists them all.

## Evidence packets

`windtunnel_evidence <run>` answers in about 600–1,300 tokens (hard cap 2k; drill-downs cap at
4k). It shows the run that broke a rule (else the first error):

- the result per ordering, anything that was **not exercised** (a perturbation that matched
  no request, a race that held only one request…), and the broken rule with its offending rows;
- the step timeline with requests other than page loads (React Server Component fetches
  marked `(RSC)`), how much SQL each ran (`· SQL 27, 10 writes`), and what the harness did
  (`[harness] response lost: the app answered 200, the browser saw a network error`);
- the race release order, charges (with or without idempotency keys) and webhook deliveries;
- the handler file for each request (from the map);
- the **trace chain** for the tables the broken rules read: each statement that wrote to
  them, with its parameters and result, the request that ran it and that request's handler
  (see below);
- database changes, rows first for the tables the broken rules read;
- the **first difference from a passing run**, compared tab by tab: another repetition in the
  same run (the same ordering first), else the latest passing run of the same experiment (for example on the fixed
  code), with its database changes and a note when that run used another version of the
  experiment file; when both sent the same requests, the first step after which a page said
  something else (`"Order confirmed…" — that run "Payment failed…"`);
- what the page showed when a flow failed (path, `role="alert"` texts, the start of the
  visible text), so a UI bug can be confirmed without opening the trace; when a locator failed,
  what it waited for and the controls that were on the page instead (`<run>/<n>/page` lists
  them all with ready-made locators);
- how the failure was sorted (bug, flaky, outdated test, environment) and by whom;
- error lines from the app log and the browser console;
- handles to drill down, and the Playwright trace command;
- while `windtunnel view` runs, a link to the run in the viewer (see [viewer.md](viewer.md)).

## Trace chain

Each run's app talks to Postgres through a small wire-protocol proxy that Wind Tunnel starts
(nothing changes in the app: its `DATABASE_URL` points at the proxy). The proxy records every
statement with its parameters, command tag (`UPDATE 0`, `INSERT 0 1`), error, duration,
connection and whether it ran in a transaction. Evidence links each statement to the request
the app was handling at that moment, each request to its handler file, and each statement to
its line in the code the run used:

```
Trace (request → handler → SQL → result) of the tables the broken rules read (every table: drill down "trace"):
  products (~1):
    1087 alice|bob POST /api/orders → app/api/orders/route.ts:28: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c1)
    1087 alice|bob POST /api/orders → app/api/orders/route.ts:28: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c2)
    1102 [payment provider] created charge ch_0001 (order 2)
    1102 [payment provider] created charge ch_0002 (order 1)
    1123 alice|bob POST /api/orders → app/api/orders/route.ts:83: UPDATE products SET stock = stock - $1 WHERE id = $2 [1, 6] → UPDATE 1 (c2, no tx)
    1124 alice|bob POST /api/orders → app/api/orders/route.ts:83: UPDATE products SET stock = stock - $1 WHERE id = $2 [1, 6] → UPDATE 1 (c1, no tx)
```

That is the oversell (case 05) in six lines: both buyers read the stock, both are charged, both
take one with an unguarded update outside any transaction.

- **What is shown:** for each table the broken rules read, the statements that wrote it and
  what the same requests read from it first, with payment calls in between. A run that broke
  no rule shows the tables its rules read, then the others it changed, and names any it left out.
- **Lines:** each statement's first line is looked up (`git grep`) in the run's own code
  version, so a run on a patch points at the patched file. SQL in a helper shows as
  `(SQL at lib/cart.ts:40)`. ORM-generated SQL has no line.
- **Markers:** `(c2)` is the connection; writes say `tx` or `no tx`.

- **Linking is by time.** A request's window runs from when it reached the app (after a race
  barrier or delay, not when the browser sent it) until its answer; pages and server-component
  fetches stream, so theirs runs until the body ends. Webhook deliveries count as requests.
- **Overlaps are shown, not guessed.** Two buyers released together both match (`alice|bob`);
  a transaction's statements are narrowed to the requests running for the whole transaction,
  and a write during a page load and a form post goes to the post.
- **Drill-downs:** `sql` lists every statement in order (with durations), `sql:<table>` those
  that mention a table, `trace` the chain for every table.
- **Off switch:** `db.sqlLog: false` in the config. It is also off when the database URL asks
  for TLS (`sslmode=require`), since the proxy only speaks plain connections.

## Re-testing only what changed

`windtunnel_run` with `affected: true` (CLI: `windtunnel run --affected`, or
`windtunnel affected` to only list) runs the experiments whose code changed and reuses the
latest result of the others, with no model work:

```
$ windtunnel affected
checkout-two-buyers    cached    none of its 21 files changed since run 261028-154134-d879, version 06e0807442a7: PASS
product-edit-two-tabs  affected  changed since run 261028-154134-9e84, version 06e0807442a7: app/api/products/[id]/route.ts (last: PASS)
```

- Every run records the requests the app received (page loads, API calls, server actions,
  webhook deliveries) and a hash of the experiment, its flows and its rules.
- An experiment's files are what handled those requests (route handlers; pages with their
  layouts, templates and boundaries; middleware) and every local module, style or data file
  they load, followed through imports, `import()` and `require()`, relative paths and tsconfig
  `paths`. The routes are resolved on the current code, so a new route that now handles one of
  its requests counts too.
- Anything that isn't app code counts for every experiment: dependencies and lockfiles,
  config files, the seed script and schema, environment files. Docs and test files count for
  none. A removed route counts for every experiment.
- A result is reused only if it came from the same experiment, flows and rules, ran at least
  as many times per ordering as asked, and didn't error. A different version of the code is
  compared with `git diff` between the two snapshots, so this takes well under a second.
- Limit: packages of a monorepo imported by name are followed only when the app's
  `package.json` uses `workspace:` dependencies, and then every change outside the app counts.

## Failure sorting and selector repair

After a run, every experiment that didn't pass is sorted, cheapest way first:

- **bug**: a rule broke. Not in every run: still a bug, timing-dependent.
- **environment**: the copy couldn't start, Postgres refused or ran out of connections, the
  browser is missing, the disk is full.
- **flaky**: some runs errored and others passed on the same code and ordering.
- Otherwise the flow failed in every run, and one more run **without perturbations** (no faults,
  race or webhook control; set-up SQL kept) tells the rest apart:
  - it finishes there: the failure only happens under the perturbation, so whether the app is
    wrong or the flow expects too much is a judgement call, a **decision** (below);
  - it fails there on a locator: the flow is **out of date**. The locator is looked up in the
    flow's files (TypeScript AST: every literal copy of that exact call), candidates come from the
    page snapshot taken at the failure, and the chosen one is written in, checked with another run
    without perturbations (the whole flow must now finish, or every edit is put back), repeated for
    the next locator if the flow now gets further (up to three), and the experiment re-run; the
    result table then shows the re-run.

```
Failure sorting (decided by rules, then you):
  checkout-slow-payment   outdated test  the flow's locators no longer matched the app; a run without perturbations now finishes [by rules]
                                         healed .windtunnel/flows/checkout.ts:27,31  getByRole('button', { name: 'Pay now' }) → getByRole("button", { name: "Place order" })
                                         re-ran the whole experiment: PASS 2/2 runs ok (run 261028-172903-70c2; first run 261028-172838-9d31)
  checkout-double-submit  outdated test  its flow was healed for another experiment above; a run without perturbations now finishes [by rules]
                                         re-ran the whole experiment: PASS 2/2 runs ok (run 261028-172910-4e02; first run 261028-172838-aa7f)
```

Rules pick a candidate only for an action (click, fill, check…) and only when it is clearly
ahead: the same words, a clear lead in similarity, or the only control of that role left on the
page. Log-out and delete-like controls are never offered in place of something else. A wait for
text (`getByText("Order confirmed").waitFor()`) checks what the app shows, so rules never heal it
unless the words are the same; a model or the agent is told to answer "none" when the page shows
a different outcome. `or()`/`and()` locators and locators built from variables are not
rewritten. `--no-triage` (CLI) skips all of this. `pnpm zoo:heal` checks it on a copy of the shop.

## Small decisions: rules, then a small model, then the agent

Choosing a candidate and sorting a failure are small multiple-choice decisions. The Decider
answers each at the cheapest level that is sure enough (`decider.confidence`, 0.8):

1. **Rules** (plain code, free).
2. **Level 1 model**, only with a key Wind Tunnel is given: **Muse Spark** (`MODEL_API_KEY`, Meta's
   chat completions with a JSON schema for the answer and `reasoning_effort: minimal`) or **Jev**
   (`OPENROUTER_API_KEY`, OpenRouter's Decisions API with a choice question). Passwords from the
   config, keys and connection strings are removed from the question first. It never uses the
   agent's own subscription.
3. **The agent**: the decision is saved and shown in the tool result with its options; the agent
   answers with `windtunnel_decide` (CLI `windtunnel decide <id> <answer>`), without opening the
   page. One decision serves every experiment stuck on the same locator.

```
decision d4efb (selector): In a run without perturbations, the flow's click on getByRole('button', { name: 'Pay now' }) (step pay) found nothing on /cart. Which element did it mean?
  …
  options:
    c1: button "Place order" (under "Cart") → page.getByRole("button", { name: "Place order" })
    none: none of these: it isn't on the page (the app changed what users see, or is broken)
    or: Playwright code for the right element, e.g. page.getByRole("link", { name: "Checkout" })
  answer with windtunnel_decide id=d4efb answer=<option>
```

`decider.use` (`auto`, `rules`, `spark`, `jev`) or `WINDTUNNEL_DECIDER` picks the level; `auto`
uses whichever key is set. Each job may spend `budget.usd` (0.50) on Level 1; after that,
decisions go to the agent.

## Usage meter and budgets

Every MCP result is counted (an estimate: 4 characters per token; "so far" leaves out the result it is in) per job, which is one MCP
session (CLI: one per day, or `WINDTUNNEL_JOB`), in `.windtunnel/logs/usage/<job>.jsonl`, with
each decision, who made it and what a Level 1 call cost. Run and prove results end with one
line:

```
usage so far (job cli-2026-10-28): 7 tool output(s) ≈ 2.9k tokens (budget 150.0k) · decisions: 2 by rules, 5 for you
```

With a Level 1 key the decisions part also counts its answers and their cost, e.g.
`1 by Muse Spark ($0.0006 of $0.5)`.

`windtunnel_evidence` with `usage` breaks it down per tool and lists earlier jobs (CLI
`windtunnel usage`). Past `budget.tokens` (150k) every result starts with a warning to wrap up;
no result is ever longer than about 6k tokens.

## Proof

`windtunnel_prove` (or `windtunnel prove <experiment…>`) runs, each in fresh copies:

1. **base**: the experiments on the code with the bug (default HEAD). Each must fail every time.
2. **fix**: the experiments on the fix (the working tree, or `patch` applied to the base).
   Each must pass every time, in every ordering.
3. **revert**: the base again, after the fix passed. It must fail again, so the pass wasn't luck.
4. **regression set**: every other experiment on base and fix. None may go from pass to anything
   else. The project's own tests (`app.test` in the config) run on both versions too, in the
   version's worktree with `DATABASE_URL` on a fresh copy of the seed data; passing on the base
   and failing on the fix is a regression.

```
$ windtunnel prove checkout-two-buyers --branch windtunnel/fix-oversell --repeat 3
Proof: base HEAD @ 451781e31bde (version 32a9b0e67040) → fix working tree @ 451781e31bde (version bc07a8d1c293), 3 runs per ordering
checkout-two-buyers (3 orderings)
  base    FAIL   stock-non-negative: together 3/3 · alice,bob 0/3 · bob,alice 0/3 run 261028-162024-82cc
  fix     PASS   9/9 ok (every ordering)                  run 261028-162024-920f
  revert  FAIL   stock-non-negative: together 3/3 · alice,bob 0/3 · bob,alice 0/3 run 261028-162128-07db
Regression set: 12 other experiment(s): 12 pass on base and fix
Project tests (pnpm -s test): base pass in 0.3 s · fix pass in 0.5 s
Verdict: PROVEN

Branch windtunnel/fix-oversell created (32f6bee27920): the fix plus
  .windtunnel/evidence/checkout-two-buyers.md
No git remote is set up, so there is nowhere to push it yet.
PR text: …/.windtunnel/logs/evidence/checkout-two-buyers.md
```

(The oversell only shows when both buyers are released `together`: that ordering fails every
time, the two sequential ones pass on both versions. 73 s in all, in a copy of the shop with the
bug committed and the fix in the working tree; that copy has no remote, otherwise the last
lines say how to push.) The base must fail every time in at least one ordering; the fix must pass every
time in all of them. A rule whose SQL errors on any stage
also makes the proof fail. Runs per ordering default to each experiment's `repeat`, at least 5.

**Branch output.** With `branch` (CLI `--branch <name>`), a proven fix becomes a branch with
one commit on the base: the fix, the experiments as regression tests with their flows and
`rules.yaml` (added or updated only where they differ from the base), and
`.windtunnel/evidence/<experiment>.md`: the proof table, orderings, regression set and tests,
changed files, and the evidence packet from the failing base run. The commit message names
the broken rules (`Fix stock-non-negative (checkout-two-buyers)`) unless `message` gives one.
The working tree, the index and the current branch are untouched, an existing branch is
never moved, and nothing is pushed. A copy of the evidence file in `.windtunnel/logs/evidence/`
serves as the PR body (`gh pr create --head <branch> --body-file <copy>`).

**Reuse.** Every proof is saved under `.windtunnel/cache/proofs/`, keyed by both code versions,
the experiments, flows and rules, and the settings. Asking for a branch after a proof (the
same arguments plus `branch`) reuses it instead of running again, in under a second.

The Bug Zoo checks the prover itself: `pnpm zoo:prove` proves the clean shop as the fix for
all seven cases and rejects a plausible wrong fix for the oversell (re-checking stock after
payment, which still races); see [`zoo/cases`](../zoo/cases/README.md).

# Using Wind Tunnel from a coding agent

Wind Tunnel does no model work itself. Your agent (Claude Code, Codex or Muse Code) does the
thinking; Wind Tunnel gives it a map of the app, runs experiments, and answers with short
evidence. Everything an agent can do also works from the CLI.

## Install

The plugin in [`plugins/windtunnel`](../plugins/windtunnel) works in Claude Code and Codex: four
skills, an MCP server and (Claude Code) a helper subagent. Muse Code reads the same skills;
see [`plugins/muse-code`](../plugins/muse-code/README.md).

```sh
# Claude Code: load the plugin from a checkout…
claude --plugin-dir ./plugins/windtunnel
# …or install it from this repository's marketplace
/plugin marketplace add Divyendra-S/msa
/plugin install windtunnel@windtunnel

# Codex
codex plugin marketplace add Divyendra-S/msa
```

The MCP server is `windtunnel mcp`. In a checkout of this repository the plugin starts it
from `packages/cli` (finding Node 22.18+ through nvm if the default `node` is older);
elsewhere it needs the `windtunnel` CLI on `PATH`. It finds `windtunnel.config.yaml` in the
current folder, a parent, or (when there is exactly one) a subfolder up to three levels down.

Fixed context cost in Claude Code: about 255 tokens (skill and agent descriptions; MCP tool
schemas load on demand). Check with `claude --plugin-dir ./plugins/windtunnel plugin details windtunnel`.

## Skills

| Skill | What the agent does |
|---|---|
| `init` | Reads the repo, writes `windtunnel.config.yaml` and a login flow after one confirmation, validates, maps the app |
| `hunt` | Reads the map, turns flagged code patterns into hypotheses, writes rules and experiments after one approval, runs them, confirms bugs with evidence, reports each with a reproducing run |
| `prove` | Fixes a reproduced bug, proves the fix with `windtunnel_prove`, and (with the user's yes) makes a branch with the fix, regression experiments and evidence |
| `test` | Re-runs only the experiments the code changes affect; looks at evidence only for failures |

In Claude Code they are `/windtunnel:init`, `/windtunnel:hunt checkout`, and so on. The
`windtunnel-helper` subagent (Haiku on Claude, Muse Spark on Muse) handles routine
follow-ups: validating, re-running, summarising evidence.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `windtunnel_map` | `focus?` | The app map (below), under about 3k tokens |
| `windtunnel_validate` | `experiments?` | `ok`, or every problem in config, flows and experiments, plus rules that error or already break on the seed data |
| `windtunnel_run` | `experiments?`, `affected?`, `repeat?`, `ref?`, `patch?` | Result table: outcome per experiment and ordering, rules broken N/N, run ids; with `affected`, which results were reused and why the rest ran |
| `windtunnel_evidence` | `handle` | Evidence packet for a run id, or one detail: `<run>/<n>/steps`, `requests`, `sql`, `sql:<table>`, `trace`, `diff`, `diff:<table>`, `rule:<id>`, `log`, `console`, `webhooks` |
| `windtunnel_branch` | `action` (`start`/`list`/`stop`), `ref?`, `patch?`, `id?` | A running copy of the app with its own database and mock payments, to try things by hand |
| `windtunnel_prove` | `experiments`, `base?`, `patch?`, `repeat?`, `branch?`, `message?` | The proof matrix and a verdict; with `branch`, the branch it created |

`patch` is a unified diff or the path to one. Long runs send MCP progress notifications
when the client asks for them.

## The app map

Built from the code in about 50 ms, plus the schema from a copy of the seed snapshot: no
model, no crawling.

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
  with no auth or signature check, webhooks with or without event-id dedupe, and session
  lookups with no expiry check.
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
- the **first difference from a passing run**, compared tab by tab: another ordering in the
  same run, else the latest passing run of the same experiment (for example on the fixed
  code), with its database changes and a note when that run used another version of the
  experiment file;
- what the page showed when a flow failed (path, `role="alert"` texts, the start of the
  visible text), so a UI bug can be confirmed without opening the trace;
- error lines from the app log and the browser console;
- handles to drill down, and the Playwright trace command.

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

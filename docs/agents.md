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
| `prove` | Fixes a reproduced bug and proves the fix with `windtunnel_prove` |
| `test` | Re-runs experiments; looks at evidence only for failures |

In Claude Code they are `/windtunnel:init`, `/windtunnel:hunt checkout`, and so on. The
`windtunnel-helper` subagent (Haiku on Claude, Muse Spark on Muse) handles routine
follow-ups: validating, re-running, summarising evidence.

## MCP tools

| Tool | Input | Returns |
|---|---|---|
| `windtunnel_map` | `focus?` | The app map (below), under about 3k tokens |
| `windtunnel_validate` | `experiments?` | `ok`, or every problem in config, flows and experiments, plus rules that error or already break on the seed data |
| `windtunnel_run` | `experiments?`, `repeat?`, `ref?`, `patch?` | Result table: outcome per experiment and ordering, rules broken N/N, run ids |
| `windtunnel_evidence` | `handle` | Evidence packet for a run id, or one detail: `<run>/<n>/steps`, `requests`, `diff`, `diff:<table>`, `rule:<id>`, `log`, `console`, `webhooks` |
| `windtunnel_branch` | `action` (`start`/`list`/`stop`), `ref?`, `patch?`, `id?` | A running copy of the app with its own database and mock payments, to try things by hand |
| `windtunnel_prove` | `experiments`, `base?`, `patch?`, `repeat?` | The proof matrix and a verdict |

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

`windtunnel_evidence <run>` answers in about 500–700 tokens (hard cap 2k; drill-downs cap at
4k). It shows the run that broke a rule (else the first error):

- the result per ordering, anything that was **not exercised** (a perturbation that matched
  no request, a race that held only one request…), and the broken rule with its offending rows;
- the step timeline with requests other than page loads (React Server Component fetches
  marked `(RSC)`), and what the harness did
  (`[harness] response lost: the app answered 200, the browser saw a network error`);
- the race release order, charges (with or without idempotency keys) and webhook deliveries;
- the handler file for each request (from the map);
- database changes, rows first for the tables the broken rules read;
- the **first difference from a passing run**, compared tab by tab: another ordering in the
  same run, else the latest passing run of the same experiment (for example on the fixed
  code), with its database changes and a note when that run used another version of the
  experiment file;
- what the page showed when a flow failed (path, `role="alert"` texts, the start of the
  visible text), so a UI bug can be confirmed without opening the trace;
- error lines from the app log and the browser console;
- handles to drill down, and the Playwright trace command.

## Proof

`windtunnel_prove` (or `windtunnel prove <experiment…>`) runs, each in fresh copies:

1. **base**: the experiments on the code with the bug (default HEAD). Each must fail every time.
2. **fix**: the experiments on the fix (the working tree, or `patch` applied to the base).
   Each must pass every time, in every ordering.
3. **revert**: the base again, after the fix passed. It must fail again, so the pass wasn't luck.
4. **regression set**: every other experiment on base and fix. None may go from pass to anything else.

```
$ windtunnel prove checkout-two-buyers --base-patch zoo/cases/05-oversell/bug.patch
Proof: base 9aec275921a9 (working tree + patch) → fix a539c5c88e16 (working tree), 5 runs per ordering
checkout-two-buyers (3 orderings)
  base    FAIL   stock-non-negative 5/15                  run 261028-131131-7c3e
  fix     PASS   15/15 ok                                 run 261028-131129-e43c
  revert  FAIL   stock-non-negative 5/15                  run 261028-131216-0ad5
Regression set: 8 other experiment(s) on the fix — none got worse
Verdict: PROVEN
```

(The oversell only shows when both buyers are released `together`: 5 of the 15 runs, every
time. The two sequential orderings pass on both versions. 66 s in all.) A rule whose SQL
errors on any stage also makes the proof fail.

Runs per ordering default to each experiment's `repeat`, at least 5. Branch output with
`EVIDENCE.md`, the trace chain and re-running only affected experiments come next (Phase 4).

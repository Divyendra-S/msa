# Flows, experiments and rules

Everything lives in `.windtunnel/` next to `windtunnel.config.yaml`:

```
.windtunnel/
  flows/<name>.ts            user journeys (Playwright), split into named steps
  flows/login.ts             how a test user logs in (used by login())
  experiments/<id>.yaml      flow + perturbations + rules + repeat count
  rules.yaml                 invariants: SQL that lists the rows breaking a rule
  runs/                      run store (git-ignored)
```

Flows, experiments and rules are read from the working tree and are **not** part of the
code version, so editing them never triggers a rebuild of the app.

## Flows

```ts
import { flow } from "windtunnel";

// Buy one product: add it to the cart, pay, and wait for the order to be confirmed.
export default flow(async ({ page, step, login, params }) => {
  await login();
  await step("add-item", async () => {
    await page.goto("/");
    await page.getByRole("button", { name: "Add to cart" }).first().click();
  });
  await step("open-cart", () => page.goto("/cart"));
  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());
  await step("confirmation", () => page.getByText("Order confirmed").waitFor());
});
```

The project doesn't need to install `windtunnel`: the import is resolved by the runner, and
flow files are always loaded as ES modules.

| In the flow context | |
|---|---|
| `page` | Playwright page; `baseURL` is the branch's app, so `page.goto("/cart")` works |
| `step(name, fn)` | A named step. Perturbations attach to step names. A step ends once the network has been quiet for 75 ms (held race requests excepted) |
| `login(user?)` | Runs `flows/login.ts` as this tab's user (or the one named); tabs of one session log in once |
| `user`, `users` | This tab's user (`name`, `email`, `password`) and every user from the config |
| `params` | `params` from the experiment file |
| `tab` | `alice`, `bob`, `alice#2` (second tab of alice's session) |
| `clock` | Playwright clock (installed when the experiment sets `clock` or uses `advance-clock`) |

Keep page actions inside steps. Each run uses a fresh browser context per user (1280×800,
`en-US`, UTC, reduced motion, service workers blocked).

## Experiments

```yaml
# .windtunnel/experiments/checkout-lost-response.yaml
description: The app saves the order but the browser never gets the answer; the user clicks again.
flow: checkout
params: { product: Ceramic Mug }   # optional, passed to the flow
users: [alice]                     # one tab per entry, all at once; repeat a name for a second tab
perturb:
  - do: lose-response
    request: POST /api/orders
    step: pay
  - do: repeat
    step: pay
webhooks: late
rules: all                         # or a list of rule ids
repeat: 3                          # runs per variant (default 3)
timeout: 60s                       # per run
```

The id is the file name. Unknown fields, steps, users, tabs and rules are errors
(`windtunnel validate`).

### Request patterns

`"METHOD /path"`: `POST /api/orders`, `GET /api/orders/:id`, `* /api/*/items`, `* /api/**`.
The query string is ignored.

### Network perturbations

Applied to requests from the browser that match `request` (optionally only during `step` or
from `tab`), to the first `count` matching requests (default 1, or `all`).

| `do` | What happens |
|---|---|
| `delay` (`ms`) | The request waits before it is sent |
| `fail` (`status`, default 503) | The harness answers; the app never sees the request |
| `lose-response` | The app handles the request; the browser gets a network error |
| `duplicate` | The app gets the request twice; the browser gets the first answer |

### Browser perturbations

Applied to a `step` (optionally only in `tab`).

| `do` | What happens |
|---|---|
| `double-submit` | Clicks in the step become double clicks; key presses and taps happen twice |
| `repeat` (`times`) | The step runs again right after it finishes (the user retries) |
| `refresh` (`when: during \| after`) | `during`: the page reloads while the step's first request is with the app |
| `back-resubmit` | After the step: Back, then the step again |
| `expire-session` (`cookie`) | Session cookies (or one cookie) are cleared before the step |
| `advance-clock` (`by`) | The browser clock jumps forward before the step |
| `second-tab` | A second tab of the same session opens on the current page and runs the flow from this step on |
| `sql` (`sql`) | One SQL statement runs against the run's database before the first tab reaches the step, e.g. to expire sessions on the server: `UPDATE sessions SET expires_at = now()` |

### Ordered races

```yaml
race:
  request: POST /api/orders
  step: pay                # optional
  count: 2                 # requests to gather (default: number of tabs, at least 2)
  order: [bob, alice]      # together (default) | arrival | reverse | each | list of tabs or arrival numbers
  timeout: 2s              # release whatever has arrived after this long
```

Matching requests are held until `count` have arrived, then released together or one at a
time (each after the previous one's response). `order: each` runs `together` plus every
ordering, each as its own variant. With `step`, only requests made during that step are held.
Sequential release shows ordering bugs; only `together` interleaves requests inside the app,
where the window can be a few milliseconds (more data widens it).

### Payment webhooks

Needs `mockPay` in the config.

| `webhooks` | What happens |
|---|---|
| `duplicate` | Each event is delivered twice |
| `early` | Delivered before the payment API answers the app |
| `late` | Held until every step running when the charge was made has finished, in every tab (retries included) |
| `out-of-order` | `late`, newest event first |
| `{ delay: 3s }` | Each delivery waits this long (a slow provider; with `late`, counted from the release) |
| `{ timing, times, order, delay }` | The long form: `timing: normal \| early \| late`, `times: 1–5`, `order: sent \| reverse` |

Shorthands can be combined: `webhooks: [early, duplicate]`.

### Fake clock

`clock: 2026-01-15T09:00:00Z` starts every browser clock at that time (timers keep running).
Server time is not faked.

## Rules

```yaml
# .windtunnel/rules.yaml
one-order-per-cart:
  description: A cart turns into at most one order.
  sql: SELECT cart_id, count(*) AS orders FROM orders GROUP BY cart_id HAVING count(*) > 1
  expect: empty
```

Each query lists the rows that break the rule; it runs read-only against the run's
database after the flow and webhooks have finished. Every run's database also holds a copy
of the seed data in the `windtunnel_seed` schema (same table names), for rules that compare
with the start, e.g. `JOIN windtunnel_seed.products s ON s.id = p.id`.

Results list anything that never took effect under "not exercised": a network perturbation
that matched no request, a race that held fewer requests than it waited for, webhooks when
the app made no payment, out-of-order webhooks with only one event at a time.

## Results

| Run outcome | |
|---|---|
| `ok` | Every rule held and the flow finished |
| `broken` | A rule broke (whether or not the flow finished) |
| `error` | The flow could not finish (or a rule query failed), no rule broke |

Per variant: **pass** (every run ok), **fail** (a rule broke in every run), **error**
(every run errored) or **flaky** (mixed; `flakeRate` is the share of runs that disagree
with the most common result).

## Run store

```
.windtunnel/runs/
  index.jsonl                        one line per run
  <run id>/                          one experiment on one code version
    run.json                         summary: outcome, variants, rule counts, every run
    experiment.json                  the experiment as run
    reps/<n>/
      result.json                    steps, actions, harness notes, rules, race, webhooks, charges, console
      requests.json                  request log: tab, step, timing, status, harness notes
      db-diff.json                   row-level diff against the seed, keyed by primary key
      app.log                        the app's output
      trace-<user>.zip               Playwright trace (runs that broke a rule or errored)
      screens/<tab>.jpg              screenshot when the flow failed
```

The newest 100 runs are kept.

## CLI

```sh
windtunnel run [experiment…]   # all experiments by default
  --repeat <n>                 # override repeat
  --ref <ref> --patch <file>   # code version (default: the working tree)
  --trace failures|on|off      # Playwright traces (default: failures)
  --keep-db                    # keep run databases
  --headed                     # show the browser
  --json                       # results as JSON
windtunnel validate [experiment…]  # also runs every rule on the seed data (each must hold there)
windtunnel runs [--limit n]
windtunnel evidence <run>[/<n>/<part>]   # evidence packet, or steps|requests|diff[:table]|rule:<id>|log|console|webhooks
windtunnel map [--focus text] [--no-schema]
windtunnel prove <experiment…> [--base ref] [--base-patch file] [--patch file] [--repeat n]
```

`run` exits with 1 unless every experiment passes; `prove` exits with 1 unless the fix is
proven. See [`agents.md`](agents.md) for evidence packets, the app map and proofs.

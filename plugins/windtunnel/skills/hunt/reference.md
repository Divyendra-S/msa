# Wind Tunnel file formats

Files live in `.windtunnel/` next to `windtunnel.config.yaml`. Flows, experiments and rules are not part of the app's code version: editing them never rebuilds the app.

## Flow: `.windtunnel/flows/<name>.ts`

```ts
import { flow } from "windtunnel";   // resolved by Wind Tunnel; nothing to install

// Buy one product and wait for the confirmation.
//   params.product  product name (default "Ceramic Mug")
export default flow(async ({ page, step, login, params }) => {
  const product: string = params.product ?? "Ceramic Mug";
  await login();                                   // runs flows/login.ts as this tab's user
  await step("add-item", async () => {
    await page.goto("/");
    const card = page.locator(".card", { has: page.getByRole("heading", { name: product }) });
    await card.getByRole("button", { name: "Add to cart" }).click();
    await card.getByText("Added").waitFor();
  });
  await step("open-cart", () => page.goto("/cart"));
  await step("pay", () => page.getByRole("button", { name: "Pay now" }).click());
  await step("confirmation", async () => {
    const done = page.getByText("Order confirmed");
    // Accept every valid ending under the experiment, or the correct app errors instead of passing.
    await (params.mayBeSoldOut ? done.or(page.getByText(/out of stock/)) : done).waitFor();
  });
});
```

- Context: `page` (Playwright, `baseURL` set), `step(name, fn)`, `login(name?)` (this tab's user, or another config user by name: `login("bob")` on the same browser, as on a shared computer; evidence then shows `alice (as bob)`), `user` / `users` (`name`, `email`, `password`), `params`, `tab` (string: `alice`, `bob`, `alice#2`), `clock`.
- A flow can branch on the tab, e.g. a second tab that keeps shopping while the first pays: `if (tab.includes("#")) { … }`.
- A step is one user action and ends when the network is quiet. Perturbations attach to step names. Keep every page action inside a step.
- Flows act like a user; they don't check for bugs. Rules do that. Use `getByRole`, `getByLabel`, `getByText` with the names the map's live crawl lists. If a name changes later, the run heals the flow file itself.
- One flow can serve many experiments through `params`.
- A request the page itself wouldn't send (someone else's id, a tampered body): send it from the page, `await page.evaluate(() => fetch("/api/orders/1"))`, so it carries the browser's cookies, goes through the harness and shows in the evidence.
- A bug that changes no data (another user's order is readable) breaks no SQL rule. There the flow checks the answer and throws: `if (res.status !== 404) throw new Error("bob can read alice's order 1")`. The run then errors with that message, and the failure sorting hands it to you to call a bug.

## Experiment: `.windtunnel/experiments/<id>.yaml`

```yaml
description: The app saves the order but the browser never gets the answer, so the user clicks "Pay now" again.
flow: checkout
params: { product: Limited Print }   # optional, passed to the flow
users: [alice, bob]                  # one tab per entry, all at once (default: first config user)
perturb:
  - do: lose-response
    request: POST /api/orders
    step: pay
  - do: repeat
    step: pay
race:
  request: POST /api/orders
  order: each
webhooks: late
rules: all                           # or [rule-id, …] (default: all)
repeat: 3                            # runs per ordering (default 3)
timeout: 60s                         # whole run (default 60s)
```

Defaults inside a run: each Playwright action waits up to 10 s, a navigation up to 15 s, and a step ends once the network has been quiet for 75 ms (at most 15 s).

The id is the file name. Unknown fields, steps, users, tabs or rules are errors.

Request patterns: `"POST /api/orders"`, `"GET /api/orders/:id"`, `"* /api/**"` (query ignored). In Next.js, client navigations and `router.refresh()` are React Server Component fetches (`GET /path?_rsc=…`, shown as `(RSC)` in evidence) that also match `GET /path`: add `step:` (and `tab:`) so a perturbation hits the request you mean.

Network perturbations (`request` required; optional `step`, `tab`, `count: n | all`):

| `do` | Effect |
|---|---|
| `delay` (`ms: 3s`) | request waits before it is sent |
| `fail` (`status: 503`) | harness answers; the app never sees it |
| `lose-response` | app handles it; the browser gets a network error |
| `duplicate` | app gets it twice; browser gets the first answer |

Browser and state perturbations (`step` required; optional `tab`):

| `do` | Effect |
|---|---|
| `double-submit` | clicks become double clicks, key presses and taps happen twice |
| `repeat` (`times`) | the step runs again right after (user retries) |
| `refresh` (`when: during \| after`) | reload while the step's first request is with the app, or after the step |
| `back-resubmit` | after the step: Back, then the step again |
| `second-tab` | a second tab of the same session opens on the current page and runs the flow from this step (tab `alice#2`) |
| `expire-session` (`cookie`) | session cookies (or one cookie) cleared before the step |
| `sql` (`sql`) | one statement on the run's database before the step, e.g. `UPDATE sessions SET expires_at = now()` |
| `advance-clock` (`by: 25h`) | browser clock jumps forward (server time is not faked) |

Race: matching requests are held until `count` arrived (default: number of tabs, at least 2), then released `together` (default), one at a time in `arrival` / `reverse` order, in a listed order (`[bob, alice]`, `[alice, "alice#2"]`, `[2, 1]`), or `each` (together plus every ordering, each its own variant). `step:` holds only requests made during that step (otherwise logins and earlier requests can be held too). Sequential release waits for each response, so it shows ordering bugs; only `together` can interleave two requests inside the app. `timeout: 2s` releases whatever arrived.

If a `together` race passes, check in the database diff which side won before ruling the bug out: the window inside a handler may be a few milliseconds. Widen it with more data (more items in the cart, more rows to process) and run with `repeat: 10`.

Webhooks (needs `mockPay` in the config; one charge sends one event, so `out-of-order` needs two charges, e.g. two users): `duplicate`, `early` (before the payment API answers the app), `late` (after every step that was running when the charge was made has finished, in every tab, retries included), `out-of-order`, `{ delay: 3s }` (a slow provider), or a list like `[late, duplicate]`.

## Rules: `.windtunnel/rules.yaml`

```yaml
one-order-per-cart:
  description: A cart turns into at most one order.
  sql: SELECT cart_id, count(*) AS orders FROM orders GROUP BY cart_id HAVING count(*) > 1
stock-non-negative:
  description: Stock never goes below zero.
  sql: SELECT id, stock FROM products WHERE stock < 0
```

Each query lists the rows that break the rule and must return nothing on the seed data. Return the columns that explain the breakage (ids, counts). Rules run read-only after the flow and webhooks finish.

To compare with the start, read the seed copy in the `windtunnel_seed` schema (same table names):

```yaml
stock-matches-sales:
  description: Stock taken since the seed equals the units in orders that didn't fail.
  sql: >-
    SELECT p.id, p.stock, s.stock - coalesce(sold.units, 0) AS expected
    FROM products p JOIN windtunnel_seed.products s ON s.id = p.id
    LEFT JOIN (SELECT oi.product_id, sum(oi.quantity)::int AS units FROM order_items oi
               JOIN orders o ON o.id = oi.order_id WHERE o.status <> 'failed'
               GROUP BY oi.product_id) sold ON sold.product_id = p.id
    WHERE p.stock <> s.stock - coalesce(sold.units, 0)
```

## Outcomes

Per run: `ok` (rules held, flow finished), `broken` (a rule broke), `error` (flow couldn't finish, no rule broke). Per experiment ordering: `pass` (all ok), `fail` (a rule broke every time), `flaky` (mixed), `error` (all errored). Results list anything that never took effect under "not exercised": a pass there proves less.

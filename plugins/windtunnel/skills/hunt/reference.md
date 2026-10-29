# Wind Tunnel file formats

Files live in `.windtunnel/` next to `windtunnel.config.yaml`. Flows, experiments and rules are not part of the app's code version: editing them never rebuilds the app.

## Flow: `.windtunnel/flows/<name>.ts`

```ts
import { flow } from "windtunnel";   // resolved by Wind Tunnel; nothing to install

// Book one seat and wait for the confirmation.
//   params.show  show name (default "Opening Night")
export default flow(async ({ page, step, login, params }) => {
  const show: string = params.show ?? "Opening Night";
  await login();                                   // runs flows/login.ts as this tab's user
  await step("pick-seat", async () => {
    await page.goto("/shows");
    const card = page.locator(".show", { has: page.getByRole("heading", { name: show }) });
    await card.getByRole("button", { name: "Pick a seat" }).click();
    await page.getByRole("button", { name: "Seat A1" }).click();
  });
  await step("open-checkout", () => page.goto("/checkout"));
  await step("pay", () => page.getByRole("button", { name: "Pay" }).click());
  await step("confirmation", async () => {
    const done = page.getByText("Booking confirmed");
    // Accept every valid ending under the experiment, or the correct app errors instead of passing.
    await (params.maySellOut ? done.or(page.getByText(/sold out/)) : done).waitFor();
  });
});
```

- Context: `page` (Playwright, `baseURL` set), `step(name, fn)`, `login(name?)` (this tab's user, or another config user by name: `login("bob")` on the same browser, as on a shared computer; evidence then shows `alice (as bob)`), `user` / `users` (`name`, `email`, `password`), `params`, `tab` (string: `alice`, `bob`, `alice#2`), `clock`.
- A flow can branch on the tab, e.g. a second tab that keeps browsing while the first pays: `if (tab.includes("#")) { … }`.
- A step is one user action and ends when the network is quiet. Perturbations attach to step names. Keep every page action inside a step.
- Flows act like a user; they don't check for bugs. Rules do that. Use `getByRole`, `getByLabel`, `getByText` with the names the map's live crawl lists. If a name changes later, the run heals the flow file itself.
- One flow can serve many experiments through `params`.
- A request the page itself wouldn't send (a tampered body, an id from the URL bar): send it from the page, `await page.evaluate(() => fetch("/api/bookings/1"))`, so it carries the browser's cookies, goes through the harness and shows in the evidence. The same request as another user: the `replay-as` perturbation.
- A bug that changes no data (another user's booking is readable, a confirmation shown for a payment that failed) breaks no rule on the app's tables: write the rule on what users got or saw (`windtunnel_requests`, `windtunnel_pages`, below).

## Experiment: `.windtunnel/experiments/<id>.yaml`

```yaml
description: The app saves the booking but the browser never gets the answer, so the user clicks "Pay" again.
flow: book-seat
params: { show: Last Show }          # optional, passed to the flow
users: [alice, bob]                  # one tab per entry, all at once (default: first config user)
perturb:
  - do: lose-response
    request: POST /api/bookings
    step: pay
  - do: repeat
    step: pay
race:
  request: POST /api/bookings
  order: each
webhooks: late
rules: all                           # or [rule-id, …] (default: all)
repeat: 3                            # runs per ordering (default 3)
timeout: 60s                         # whole run (default 60s)
```

Defaults inside a run: each Playwright action waits up to 10 s, a navigation up to 15 s, and a step ends once the network has been quiet for 75 ms (at most 15 s).

The id is the file name. Unknown fields, steps, users, tabs or rules are errors.

Request patterns: `"POST /api/bookings"`, `"GET /api/bookings/:id"`, `"* /api/**"` (query ignored). In Next.js, client navigations and `router.refresh()` are React Server Component fetches (`GET /path?_rsc=…`, shown as `(RSC)` in evidence) that also match `GET /path`: add `step:` (and `tab:`) so a perturbation hits the request you mean.

Network perturbations (`request` required; optional `step`, `tab`, `count: n | all`):

| `do` | Effect |
|---|---|
| `delay` (`ms: 3s`) | request waits before it is sent |
| `fail` (`status: 503`, `after: 3s`) | harness answers (after `after`: a slow server that gives up); the app never sees it |
| `lose-response` | app handles it; the browser gets a network error |
| `duplicate` | app gets it twice; browser gets the first answer |
| `replay-as` (`user: bob`) | app answers the tab; then the same request is sent again with another test user's session (tab `bob (replay)`, logged in before the flow starts). Catch it with a rule on `windtunnel_requests` |

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
one-booking-per-seat:
  description: A seat is booked at most once per show.
  sql: >-
    SELECT show_id, seat, count(*) AS bookings FROM bookings
    WHERE status <> 'cancelled' GROUP BY show_id, seat HAVING count(*) > 1
show-never-oversold:
  description: A show never has more bookings than seats.
  sql: >-
    SELECT s.id, s.capacity, count(*) AS booked FROM shows s JOIN bookings b ON b.show_id = s.id
    WHERE b.status <> 'cancelled' GROUP BY s.id, s.capacity HAVING count(*) > s.capacity
```

Each query lists the rows that break the rule and must return nothing on the seed data. Return the columns that explain the breakage (ids, counts). Rules run read-only after the flow and webhooks finish.

To compare with the start, read the seed copy in the `windtunnel_seed` schema (same table names):

```yaml
balance-matches-ledger:
  description: Each balance moved by exactly the ledger entries added since the start.
  sql: >-
    SELECT a.id, a.balance, s.balance + coalesce(l.total, 0) AS expected
    FROM accounts a JOIN windtunnel_seed.accounts s ON s.id = a.id
    LEFT JOIN (SELECT account_id, sum(amount) AS total FROM ledger
               WHERE id NOT IN (SELECT id FROM windtunnel_seed.ledger)
               GROUP BY account_id) l ON l.account_id = a.id
    WHERE a.balance <> s.balance + coalesce(l.total, 0)
```

Rules can also read what users got and saw: two tables of the run, next to the app's own (they exist only while the rules run; the app's database is not changed).

| Table | Columns |
|---|---|
| `windtunnel_requests` | `id, tab, user_name, user_email, step, method, path, query, status, failure, reached_app, at_ms, harness`: every request a page (or `replay-as`) sent; `status` is null when no answer came |
| `windtunnel_pages` | `tab, user_name, user_email, step, attempt, at_ms, path, text`: the page's visible text (first 2,000 characters) when each step ended |

```yaml
documents-shown-only-to-their-owner:
  description: A document is shown only to its owner.
  sql: >-
    SELECT r.user_name, r.path, r.status, d.owner_id
    FROM windtunnel_requests r JOIN users u ON u.email = r.user_email
    JOIN documents d ON d.id = substring(r.path from '^/api/documents/(\d+)$')::int
    WHERE r.status = 200 AND d.owner_id <> u.id
booking-confirmed-means-paid:
  description: When a page says "Booking confirmed", its user has a paid booking.
  sql: >-
    SELECT p.tab, p.step FROM windtunnel_pages p JOIN users u ON u.email = p.user_email
    WHERE p.text LIKE '%Booking confirmed%'
      AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = u.id AND b.status = 'paid')
```

## Outcomes

Per run: `ok` (rules held, flow finished), `broken` (a rule broke), `error` (flow couldn't finish, no rule broke). Per experiment ordering: `pass` (all ok), `fail` (a rule broke every time), `flaky` (mixed), `error` (all errored). Results list anything that never took effect under "not exercised": a pass there proves less.

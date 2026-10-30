# Bug Zoo cases

The shop in `zoo/shop` is the clean version: it guards against every case below.
Each case folder holds one `bug.patch` that removes one guard, written the way
real code usually goes wrong, plus `case.yaml` with the expected result. A case may also
hold a `wrong-fix.patch`: the bug with a fix that looks right but isn't (05: re-checking the
stock after payment, which still races).

| Case | Experiment | Rule that breaks | Handler |
|---|---|---|---|
| 01 double submit | `checkout-double-submit` | `one-order-per-cart` | `app/api/orders/route.ts` |
| 02 lost response + retry | `checkout-lost-response` | `one-charge-per-order` | `app/api/orders/route.ts` |
| 03 duplicate webhook | `checkout-duplicate-webhook` | `payment-recorded-once` | `app/api/webhooks/payment/route.ts` |
| 04 early webhook | `checkout-early-webhook` | `paid-orders-are-marked-paid` | `app/api/orders/route.ts` |
| 05 oversell | `checkout-two-buyers` (variant `together`) | `stock-non-negative` | `app/api/orders/route.ts` |
| 06 session expiry | `checkout-session-expired` | `orders-need-a-live-session` | `lib/auth.ts` |
| 07 lost update | `product-edit-two-tabs` | `no-lost-update` | `app/api/products/[id]/route.ts` |
| 08 back and resubmit | `checkout-back-resubmit` | `one-order-per-cart` | `app/api/orders/route.ts` |
| 09 another user's order (IDOR) | `order-read-by-another-user` | `orders-shown-only-to-their-buyer` | `app/api/orders/[id]/route.ts` |
| 10 success before confirmation | `checkout-slow-then-fails` | `confirmation-means-paid` | `components/PayButton.tsx` |

- **08**: orders are unique per cart only while unpaid ("so a failed payment can be retried"),
  so Back after the payment went through, then **Pay now** on the cached cart page, orders
  and charges the cart again. A double click or a retry before the payment settles is still
  caught; `checkout-retry-after-paid` breaks too.
- **09**: the order status API checks that someone is logged in, not that the order is theirs.
  `replay-as` sends Alice's status request again with Bob's session; the rule reads the request
  log (`windtunnel_requests`), since nothing in the database changes.
- **10**: when checkout takes over 2.5 s the pay button shows "Order confirmed" and ignores
  what the server says later. The experiment answers `POST /api/orders` with a 502 after 3 s;
  the rule reads what the page said (`windtunnel_pages`). A slow checkout that succeeds
  (`checkout-slow-payment`) still passes: the order ends up paid.

## Clean controls

Each control is the clean shop with one guard rewritten in a way that is still correct but
looks risky (`control.patch`). Every experiment must pass on it, and in the benchmark any
finding on a control counts as a false alarm.

| Control | Looks like | Why it is correct |
|---|---|---|
| c1 stock taken under a row lock | 05 oversell: read stock, then a plain `UPDATE … SET stock = stock - $1` (the map flags a blind UPDATE) | the read is `SELECT … FOR UPDATE` inside the order's transaction, in product id order |
| c2 webhook deduped by a unique charge id | 03 duplicate webhook: no event-id table (the map flags missing dedupe) | `payments.charge_id` is unique and the insert is `ON CONFLICT DO NOTHING`; nothing else happens unless it inserted |
| c3 order owner checked in code | 09 another user's order: `SELECT … WHERE id = $1` (the map flags no owner in the query) | the handler compares the order's user with the session's and answers 404 |

Flows, experiments and rules live in `zoo/shop/.windtunnel/`.

Two blind hunts (an agent with only the hunt skill, the map and the CLI) found four bugs
in the clean shop itself. They are fixed, and these experiments keep them fixed:

| Experiment | The bug it guards against |
|---|---|
| `checkout-add-while-paying` | An item added in another tab while checkout ran (before, after or at the same moment) vanished into the ordered cart (`ordered-cart-matches-order`) |
| `checkout-slow-webhook` | The order page polled once and never showed "Order confirmed" after a slow webhook |
| `checkout-retry-after-paid` | A retry after the webhook had paid the order said "Your cart is empty" |
| `order-page-session-expires` | The order page kept polling and spinning after the session ended |

## Verify

`pnpm zoo:verify` runs every experiment in `zoo/shop/.windtunnel/experiments` against the
clean shop, every case variant and every control (each run in its own branch) and checks that:

- the clean shop and every control pass every experiment, and
- each case variant breaks its expected rules in its own experiment (`experiment` in
  `case.yaml`), in every run (of one race ordering when `case.yaml` names a `variant`).

It prints one line per variant: what didn't pass (the case's own experiment first, marked
`*`), then how many others passed.

Options: `--repeat <n>` (default 3), `--case <id>`, `--experiment <id>` (repeatable), `--app
notes` or `--app shop-android` for the other zoo apps, whose cases are in their own `cases/`. A
`case.yaml` there with `from: <folder>` reuses that case's patch and description with its own
experiment: `zoo/shop-android` catches the shop's bugs from the phone that way.

## Prove

`pnpm zoo:prove` checks the prover against the answer key, with every proof running at once:

- for every case, the clean shop is **proven** as the fix for its bug (the experiment fails
  with the bug every time, passes without it in every ordering, and fails again with it);
- every `wrong-fix.patch` is **not proven**.

The shop's own tests (`pnpm test` in `zoo/shop`: database constraints, run against a fresh
seed copy) run on both sides of each proof; case 01's bug drops a unique constraint, so its
base fails them too. Options: `--repeat <n>` (default 3), `--case <id>`, `--regression`
(also run every other experiment on both sides, which takes much longer).

```
ok   05-oversell: wrong fix: not proven
     checkout-two-buyers (3 orderings)
       base    FAIL   stock-non-negative: together 3/3 · alice,bob 0/3 · bob,alice 0/3 run 261028-162747-bd1b
       fix     FAIL   stock-non-negative: together 3/3 · alice,bob 0/3 · bob,alice 0/3 run 261028-162805-c225
       revert  FAIL   stock-non-negative: together 3/3 · alice,bob 0/3 · bob,alice 0/3 run 261028-162840-8931
     Verdict: NOT PROVEN
       - checkout-two-buyers still fails with the fix (together: fail 0/3 ok; run 261028-162805-c225)

8 proof(s) in 79.5 s
PASS: every real fix is proven and every wrong fix is rejected.
```

The wrong fix's evidence shows why: both buyers pass the first stock check, both are charged,
both pass the re-check (the same SQL, on line 28 and line 84), and both take one, outside any
transaction:

```
products (~1):
  999 bob|alice POST /api/orders → app/api/orders/route.ts:28,84: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c2)
  1001 bob|alice POST /api/orders → app/api/orders/route.ts:28,84: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c1)
  1010 [payment provider] created charge ch_0001 (order 1)
  1012 [payment provider] created charge ch_0002 (order 2)
  1033 bob|alice POST /api/orders → app/api/orders/route.ts:28,84: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c1)
  1033 bob|alice POST /api/orders → app/api/orders/route.ts:28,84: SELECT stock FROM products WHERE id = $1 [6] → SELECT 1 (c2)
  1033 bob|alice POST /api/orders → app/api/orders/route.ts:86: UPDATE products SET stock = stock - $1 WHERE id = $2 [1, 6] → UPDATE 1 (c1, no tx)
  1034 bob|alice POST /api/orders → app/api/orders/route.ts:86: UPDATE products SET stock = stock - $1 WHERE id = $2 [1, 6] → UPDATE 1 (c2, no tx)
```

## Heal

`pnpm zoo:heal` checks failure sorting and selector repair, rules only (no model, whatever
keys are set), on a throwaway copy of the shop. Each scenario changes the copy, runs one
experiment, sorts the failure and puts the copy back:

| Scenario | Expected |
|---|---|
| "Pay now" renamed "Place order" | outdated test; both calls in `checkout.ts` healed, checked, re-run passes |
| login label "Email" renamed "E-mail" | outdated test; `login.ts` and `checkout.ts` healed (still `getByLabel`), re-run passes |
| "Order confirmed" changed to "Order received" | a check of what the app shows: not healed, a decision for the agent |
| case 05's bug | bug (a rule broke), nothing healed |
| a 503 on `POST /api/orders` | fails only under the perturbation: a decision for the agent, nothing healed |

```
ok   renamed form label
     Failure sorting (decided by rules, then you):
       checkout-slow-payment  outdated test  the flow's locators no longer matched the app; a run without perturbations now finishes [by rules]
                                             healed .windtunnel/flows/checkout.ts:11,37  getByLabel('Email') → getByLabel("E-mail")
                                             healed .windtunnel/flows/login.ts:6  getByLabel('Email') → getByLabel("E-mail")
                                             re-ran the whole experiment: PASS 1/1 runs ok (run 261028-173156-4b82; first run 261028-173132-87e8)

5 scenario(s) in 130.3 s
PASS: renamed controls are healed and re-run, checks and bugs are not papered over.
```

`--keep` leaves the copy in place for a look.

## Patches

Patches are made against the clean shop with repository-relative paths
(`a/zoo/shop/...`); `wrong-fix.patch` too (it contains the bug). `pnpm zoo:verify` and
`pnpm zoo:prove` fail if a patch no longer applies (`zoo:heal` applies case 05's).

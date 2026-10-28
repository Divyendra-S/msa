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
clean shop and every case variant (each run in its own branch) and checks that:

- the clean shop passes every experiment, and
- each case variant breaks its expected rules in its own experiment (`experiment` in
  `case.yaml`), in every run (of one race ordering when `case.yaml` names a `variant`).

Options: `--repeat <n>` (default 3), `--case <id>`, `--experiment <id>` (repeatable).

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

## Patches

Patches are made against the clean shop with repository-relative paths
(`a/zoo/shop/...`); `wrong-fix.patch` too (it contains the bug). `pnpm zoo:verify` and
`pnpm zoo:prove` fail if a patch no longer applies.

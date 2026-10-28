# Bug Zoo cases

The shop in `zoo/shop` is the clean version: it guards against every case below.
Each case folder holds one `bug.patch` that removes one guard, written the way
real code usually goes wrong, plus `case.yaml` with the expected result.

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

## Patches

Patches are made against the clean shop with repository-relative paths
(`a/zoo/shop/...`). `pnpm zoo:verify` fails if a patch no longer applies.

To check that the clean code proves as the fix for a case (it fails with the bug every
time, passes without it in every ordering, fails again with it, and nothing else gets
worse):

```sh
pnpm wt --cwd zoo/shop prove checkout-two-buyers --base-patch zoo/cases/05-oversell/bug.patch
```

# Bug Zoo cases

The shop in `zoo/shop` is the clean version: it guards against every case below.
Each case folder holds one `bug.patch` that removes one guard, written the way
real code usually goes wrong, plus `case.yaml` with the expected result.

| Case | Experiment | Rule that breaks | Handler |
|---|---|---|---|
| 01 double submit | `checkout-double-submit` | `one-order-per-cart` | `app/api/orders/route.ts` |
| 02 lost response + retry | `checkout-lost-response` | `one-charge-per-order` | `app/api/orders/route.ts` |
| 03 duplicate webhook | `checkout-duplicate-webhook` | `payment-recorded-once` | `app/api/webhooks/payment/route.ts` |

Flows, experiments and rules live in `zoo/shop/.windtunnel/`.

## Verify

`pnpm zoo:verify` runs every experiment in `zoo/shop/.windtunnel/experiments` against the
clean shop and every case variant (each run in its own branch) and checks that:

- the clean shop passes every experiment, and
- each case variant breaks its expected rules in its own experiment (`experiment` in
  `case.yaml`), in every run.

Options: `--repeat <n>` (default 3), `--case <id>`, `--experiment <id>` (repeatable).

## Patches

Patches are made against the clean shop with repository-relative paths
(`a/zoo/shop/...`). `pnpm zoo:verify` fails if a patch no longer applies.

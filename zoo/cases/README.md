# Bug Zoo cases

The shop in `zoo/shop` is the clean version: it guards against every case below.
Each case folder holds one `bug.patch` that removes one guard, written the way
real code usually goes wrong, plus `case.yaml` with the expected result.

| Case | Perturbation | Rule that breaks | Handler |
|---|---|---|---|
| 01 double submit | Double click "Pay now" | `one-order-per-cart` | `app/api/orders/route.ts` |
| 02 lost response + retry | Response dropped after save, user retries | `one-charge-per-order` | `app/api/orders/route.ts` |
| 03 duplicate webhook | Webhook delivered twice | `payment-recorded-once` | `app/api/webhooks/payment/route.ts` |

Rules live in `zoo/shop/.windtunnel/rules.yaml`.

## Verify

`pnpm zoo:verify` runs every scenario against the clean shop and every case
variant (each in its own branch) and checks that:

- the clean shop breaks no rule in any scenario, and
- each case variant breaks its expected rules in its own scenario, every time.

Options: `--repeat <n>` (default 3), `--case <id>`.

The scenarios in `verify.ts` are plain Playwright for now. They move to
experiment files once the experiment engine exists (Phase 2).

## Patches

Patches are made against the clean shop with repository-relative paths
(`a/zoo/shop/...`). `pnpm zoo:verify` fails if a patch no longer applies.

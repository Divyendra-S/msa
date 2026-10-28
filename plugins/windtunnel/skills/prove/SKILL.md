---
name: prove
description: "Fix a bug that a Wind Tunnel experiment reproduces and prove it: fails before, passes after in every ordering, nothing else breaks."
---

# Fix and prove

Input: the bug to fix, as an experiment id (from a hunt report or `windtunnel_run`), or a description you can match to an experiment. If no experiment reproduces the bug yet, write one first (see the hunt skill) and make sure it fails.

## 1. Understand

Call `windtunnel_evidence` on the failing run if you don't have it. Read the handler file it names. State the root cause in one or two sentences before changing anything.

## 2. Fix

Make the smallest change that removes the cause, not the symptom. Fixes that hold under concurrency and retries:

- Duplicate creates: a unique constraint plus `INSERT … ON CONFLICT` (or a natural idempotency key), not a "check if it exists" query.
- Retried external calls: an idempotency key derived from the record (`order-<id>`), so the retry gets the first result.
- Webhooks: record handled event ids (`INSERT … ON CONFLICT DO NOTHING`, skip if nothing was inserted) in the same transaction as the effect.
- Check-then-act on counters (stock, balance): one conditional statement, `UPDATE … SET stock = stock - $1 WHERE id = $2 AND stock >= $1`, and treat 0 rows as "not enough".
- State machines: move state only forward (`UPDATE … WHERE status = 'pending'`), so a late actor can't undo an earlier one.
- Lost updates: a version column, `UPDATE … WHERE id = $1 AND version = $2`, and a 409 when nothing matched.
- Sessions and permissions: check them on every request, server side.

Schema changes go in the migration or seed the config's `db.seed` runs, so the next build picks them up. Sleeps, retries and client-only guards (disabling a button) are not fixes.

If the user hasn't agreed to edits in the working tree, write the fix as a unified diff and pass it as `patch` instead.

## 3. Prove

Call `windtunnel_prove` with the experiment ids (and `patch` if you didn't edit the working tree). It runs, each in fresh copies of the app and database:

- **base**: the experiments on the code without the fix (HEAD): they must fail every time.
- **fix**: the experiments with the fix: they must pass every time, in every ordering.
- **revert**: the base again: it must fail again, so the pass wasn't luck.
- **regression set**: every other experiment on base and fix: none may go from pass to anything else.

If the verdict is NOT PROVEN, read the reasons. Use `windtunnel_evidence` on the failing run ids it lists, adjust the fix, and prove again. Stop after three attempts and report what you learned.

## 4. Report

```
Fixed: <bug title>
Cause: <one sentence>   Change: <files>
Proof: base FAIL <rule> N/N · fix PASS N/N (every ordering) · revert FAIL N/N · regression set: no change
Runs: <base run> <fix run> <revert run>
```

Suggest committing the fix together with the experiment and rules, which now guard against the bug coming back.

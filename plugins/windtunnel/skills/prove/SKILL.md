---
name: prove
description: "Fix a bug that a Wind Tunnel experiment reproduces and prove it: fails before, passes after in every ordering, nothing else breaks."
---

# Fix and prove

Input: the bug to fix, as an experiment id (from a hunt report or `windtunnel_run`), or a description you can match to an experiment. If no experiment reproduces the bug yet, write one first (see the hunt skill) and make sure it fails.

## 1. Understand

If you have only an experiment id, run it (`windtunnel_run` with that id) to get a failing run id. Call `windtunnel_evidence` on the failing run. Its trace links the broken rule's table to the statements that wrote it (and what those requests read first), with the handler file and line, the connection, whether a transaction was open, and payment calls in between; read that file. State the root cause in one or two sentences before changing anything.

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

If the fix moves an effect (stock taken before payment instead of after, work moved into a transaction), name the paths that now behave differently (a failed payment, a timeout) and check whether any experiment covers them. If none does, say so in the report: the proof only covers what the experiments exercise.

## 3. Prove

Call `windtunnel_prove` with the experiment ids (and `patch` if you didn't edit the working tree). It runs, each in fresh copies of the app and database:

- **base**: the experiments on the code without the fix (HEAD): they must fail every time, in at least one ordering (a race may break only when both requests go `together`; the output shows each ordering).
- **fix**: the experiments with the fix: they must pass every time, in every ordering.
- **revert**: the base again: it must fail again, so the pass wasn't luck.
- **regression set**: every other experiment on base and fix: none may go from pass to anything else. The project's own tests (`app.test` in the config) run on both too, each against a fresh copy of the seed data.

If the verdict is NOT PROVEN, read the reasons. Use `windtunnel_evidence` on the failing run ids it lists, adjust the fix, and prove again. Stop after three attempts and report what you learned.

## 4. Branch and report

Once proven, offer a branch. With the user's yes, call `windtunnel_prove` again with the same arguments plus `branch` (e.g. `windtunnel/fix-<experiment>`): if nothing changed, the proof is reused rather than run again. The branch gets one commit on the base: the fix, the experiments as regression tests (with their flows and `rules.yaml`), and `.windtunnel/evidence/<id>.md` (proof table, changed files, evidence from the failing run). It doesn't touch the working tree or switch branches. Don't push or open a PR without asking; when asked, use the evidence copy it prints as the PR body (`gh pr create --head <branch> --body-file <copy>`).

```
Fixed: <bug title>
Cause: <one sentence>   Change: <files>
Proof: base FAIL <rule> (<ordering> N/N) · fix PASS N/N (every ordering) · revert FAIL · regression set: N pass on both · tests: pass
Not covered: <paths the fix changes that no experiment exercises, or "nothing">
Runs: <base run> <fix run> <revert run>   Branch: <name or "not created">
```

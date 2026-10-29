# Demo

About three minutes: Muse Code hunts in the demo shop from the viewer, the experiments break
three rules, and it proves its fixes.

## The app

`pnpm demo:setup` makes the demo shop outside this repository (default
`$TMPDIR/windtunnel-demo/shop`, `--dir` to change, `--force` to start over): the Bug Zoo shop
with three bugs at once ([`zoo/demo/demo.patch`](../zoo/demo/demo.patch)), as a single commit,
with Wind Tunnel set up as after `/windtunnel:init` (the config and the login flow only; the
agent writes the rules and experiments).

| Bug | What breaks | The map says |
|---|---|---|
| Double submit: the pay button stays enabled and orders aren't unique per cart | two orders for one cart | `INSERT orders: no ON CONFLICT and no unique key besides the id` |
| Duplicate webhook: event ids aren't recorded | the payment recorded twice | `webhook with no event-id dedupe` |
| Oversell: stock checked before the order, taken after payment | stock below zero | `check-then-act on products` |

With the zoo's own experiments, the patch breaks `one-order-per-cart`,
`payment-recorded-once` and `stock-non-negative` in every run (`pnpm wt --cwd zoo/shop run
--all --patch zoo/demo/demo.patch`).

## Before recording

1. `pnpm db:up`, and Muse Code set up and checked ([`docs/muse.md`](muse.md)).
2. `pnpm demo:setup --force`, then in the Muse shell run the commands it prints:
   `windtunnel prepare` (builds the app and the seed snapshot, so the first run starts in
   seconds), then `windtunnel view`.
3. Rehearse once with Spark (`hunt.command` with `--model muse-spark-1.3`, or `pnpm bench
   check --paid` first), then `pnpm demo:setup --force` again for a clean take.
4. A real hunt takes longer than the video: record all of it, then cut. Keep the uncut
   recording and the run ids; the viewer keeps every run for the close-ups.
5. Have the scoreboard ready: `pnpm bench board`.

## Script

1. **Hook (15 s).** "Agents say they fixed it. Here's what proof looks like, running on
   Meta's Muse models." The viewer, empty.
2. **Hunt (60 s).** Hunt page: the prompt is filled in (hunt skill, prove what you find).
   Click **Run hunt**. Muse Code (Muse Wonder) starts in the shop; its steps stream in. It
   reads the map, which flags the three spots above, and writes rules: one order per cart,
   a payment recorded once, stock never below zero.
3. **Experiments (45 s).** Runs page: the experiments start from the same snapshot (a double
   click on Pay, a duplicate webhook, two buyers for the last item). Three turn red. Open the
   double-submit run: the lanes line up step by step, the first divergence is marked, and the
   trace chain goes from the second `POST /api/orders` to the handler line to the second
   `INSERT INTO orders`. The database diff shows the two orders.
4. **Proof (45 s).** The agent patches each bug in a worktree and runs the proof: every
   ordering passes in every run (at least 5 each); reverting the patch fails again; the
   other experiments don't get worse. It opens a branch with the fix, the experiments as
   regression tests and `.windtunnel/evidence/<id>.md`.
5. **Numbers (15 s).** The Bug Zoo scoreboard: A, B and C on Muse Wonder, with tokens and
   time per proven fix.

## If something goes wrong

- **Muse Code stalls or is slow:** cut to the rehearsal's runs (they stay in the viewer), or
  run the same hunt with the backup host (`source scripts/muse-env.sh --claude`, then
  `claude --plugin-dir <repo>/plugins/windtunnel` and `/windtunnel:hunt checkout`), and say
  which host it is.
- **No credits left:** the demo works in Claude Code on your own login too (`pnpm
  demo:setup` prints the command). Don't present that as a Muse run.

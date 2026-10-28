---
name: test
description: "Re-run Wind Tunnel experiments on the current code and report what passes and what broke."
---

# Re-run experiments

1. Call `windtunnel_run` with `affected: true`: it runs only the experiments whose code changed since their last result (the handlers and pages their requests reached, everything those import, plus config, dependencies and seed) and reuses the others' results. Pass `experiments` to narrow it, or leave out `affected` to run everything again. Runs need no model work: just wait for the table.
2. If everything passes, report one line per experiment (say which were reused) and stop.
3. For each experiment that fails, is flaky or errors, call `windtunnel_evidence` with its run id and summarise in two or three lines: the rule broken (or the step that errored), the request where it went wrong, and the handler file. Say whether it looks like a real regression (a rule broke) or an outdated experiment (a selector or page changed, so the flow errored).

Don't fix anything unless asked; offer the prove skill for real regressions.

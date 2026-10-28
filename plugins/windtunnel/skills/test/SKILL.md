---
name: test
description: "Re-run Wind Tunnel experiments on the current code and report what passes and what broke."
---

# Re-run experiments

1. Call `windtunnel_run` with `affected: true`: it runs only the experiments whose code changed since their last result (the handlers and pages their requests reached, everything those import, plus config, dependencies and seed) and reuses the others' results. Pass `experiments` to narrow it, or leave out `affected` to run everything again. Runs need no model work: just wait for the table.
2. If everything passes, report one line per experiment (say which were reused) and stop.
3. Failures come back already sorted (`Failure sorting`): **bug** (a rule broke), **flaky** (some runs errored, others passed), **outdated test** (the flow no longer fits the app) or **environment** (the machine, not the app). Renamed buttons, links and labels are healed in the flow files on the spot, checked with a run, and the experiment re-run (`healed …`, `re-ran the whole experiment: PASS`); the result table already shows the re-run. Report that, nothing else to do.
4. A line marked **for you** is a small decision the tool could not settle (which element a renamed locator means, or whether a failure under a perturbation is a bug). Answer it with `windtunnel_decide` (`id`, `answer`: an option id, or Playwright code for a selector). Read the options; don't open the page or the evidence for it.
5. For each **bug**, call `windtunnel_evidence` with its run id and summarise in two or three lines: the rule broken, the request where it went wrong, and the handler file.

Don't fix application code unless asked; offer the prove skill for real regressions.

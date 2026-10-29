---
name: hunt
description: "Find real bugs in an app area (e.g. checkout): map risky code, write experiments and SQL rules, run them, report reproduced bugs."
---

# Hunt for bugs

Goal: find bugs that real users hit under real-world conditions (double clicks, lost responses, retries, duplicate or early webhooks, two users at once, expired sessions, two tabs), and reproduce each one with an experiment that fails every time. The code and the map tell you where to look; don't click around the app hoping to find something.

Input: an area (`checkout`, `orders`, `admin`), or nothing for the whole app.

## 1. Map

Call `windtunnel_map` (with `focus` for an area: it matches paths, files, handler comments, tables, requests and page text; if nothing matches it lists the routes). For each API handler it lists what the handler does in order (auth, SELECT, INSERT, UPDATE, `tx{…}`, external calls) and flags patterns with `!` (`✓` marks a guard it saw). Then read the handler files of the routes in your area, and any helper they call that matters (auth, payments, stock). Flags are hints, not findings: the code decides.

If the map ends with "no live crawl yet" (or says the code changed since), call it once more with `crawl: true`: Wind Tunnel runs the app and visits its pages as a visitor and a test user, adding the exact names of buttons, links and fields per page, and a free sweep (console errors, failed requests, broken links, accessibility, slow pages) found with no model. Sweep findings with severity `high` are often real bugs worth a line in the report.

## 2. Hypotheses

For each suspicious spot write one line: the real-world event, the perturbation that recreates it, and the rule that would catch the damage.

| Code pattern | Real-world event | Experiment |
|---|---|---|
| POST that creates something, no unique key / ON CONFLICT | double click, retry, two tabs | `double-submit` + `race`, `second-tab` + `race`, `back-resubmit` |
| External call (payments, email) before or after a write | response lost after the server saved; user retries | `lose-response` on the request + `repeat` of the step; `webhooks: late` |
| Webhook handler | provider delivers twice, early, late, out of order | `webhooks: duplicate`, `early`, `late`, `out-of-order` |
| Read a value, then write based on it (stock, balance, seats, status) | two users at the same moment | `users: [alice, bob]` + `race: { request: …, order: each }` |
| UPDATE that only matches the id (no version/state check) | two tabs or two editors save | `second-tab` at the edit step + `race` with an `order` |
| State moved forward by several actors (app, webhook, job) | events arrive in another order | `webhooks: early`, `delay` on one request |
| Session or permission lookup | session expires or is revoked mid-flow | `sql` perturbation that expires sessions on the server; `expire-session` (cookie) |
| Row loaded by the id in the path, owner not in the query | another user tries the id | `replay-as` the request with another user + a rule on `windtunnel_requests` |
| Success shown before the server confirms | slow or failing request | `delay`, `fail` with `after` + a rule on `windtunnel_pages` |

Prefer the 3–6 most likely bugs over covering everything.

## 3. Rules

A rule is an invariant about the data: SQL that lists the rows breaking it (no rows = rule holds). Write what must always be true, not how the code works: "a seat is booked at most once", "a balance never goes below zero", "each payment event is recorded once", "a paid booking is not left pending", "two saves never start from the same version". Rules run after every run of every experiment, so a good rule catches bugs you didn't aim for. Rules can also join what users got and saw (`windtunnel_requests`, `windtunnel_pages`): "only the owner gets a document", "a confirmation means a paid booking". Keep existing rules; add new ones to `.windtunnel/rules.yaml`.

## 4. Experiments and flows

Reuse the flows listed in the map. Write a new flow only when no flow reaches the code you're testing; use the control names the live crawl lists for each page (`windtunnel_evidence` with handle `crawl:/cart` gives one page with ready-made locators). Read `reference.md` (next to this file) for the exact flow, experiment and rule formats.

Propose all new rules and experiments to the user in one short list (id, what it simulates, rule it targets) and ask once. In a non-interactive run, go ahead.

Then write the files and call `windtunnel_validate`. It runs every rule on the seed data too: a rule that already has rows there is wrong.

## 5. Run

Call `windtunnel_run` with your new experiments (all at once: they run in parallel, each in its own app and database copy).

- **pass**: hypothesis ruled out, unless the result lists it under "not exercised" (a perturbation matched no request, a race held only one request, out-of-order webhooks had one event): then the experiment tested nothing; fix it and run again. Keep passing experiments; they guard against regressions.
- **fail / flaky**: call `windtunnel_evidence` with the run id. Check that the broken rule's rows, the step timeline and the database changes really show the bug. Its trace lists the statements that wrote the rule's tables (and what those requests read first), with parameters, results and the handler. Drill down (`<run>/1/sql:<table>`, `<run>/1/requests`, `<run>/1/diff:<table>`, `<run>/1/log`) only for what the packet doesn't answer. Then read the handler file it names and find the line.
- **error**: the flow couldn't finish. The run's `Failure sorting` says why: a renamed button or label is healed in the flow file and re-run for you; a line marked **for you** is a small decision to answer with `windtunnel_decide` from its options alone. Otherwise read the step error and the page shown in the evidence (its controls are listed). Usually the flow needs fixing: an ending it should accept (the losing buyer sees "sold out", the second editor sees "changed by someone else"). Fix it and run again. It can also be a real UI bug: the data ends up right but the page never gets there (a spinner that never stops, a confirmation that never shows). Report that as a UI bug only when the evidence shows it: the database reached the final state, and the requests show the page stopped asking.

A failure caused by a wrong rule or a broken flow is not a bug: fix the experiment, run again. Flaky results: run that experiment again with `repeat: 10` before reporting.

## 6. Report

For each confirmed bug:

```
### <short title>
Reproduce: windtunnel run <experiment-id>   (fails N/N; run <run id>)
Rule broken: <rule-id> — <rows, e.g. booking 1 has 2 charges>
What happens: <2–3 sentences: the event, then what the code does wrong>
Where: <file>:<line>
Fix: <the smallest correct fix>
View: <the evidence packet's "Viewer:" link, if it has one>
```

Then list the experiments that passed (what you ruled out), and any `high` free-sweep findings in one line each. Don't change application code during a hunt; offer the prove skill to fix and prove each bug.

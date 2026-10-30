# Viewer and local API

`windtunnel view` starts a local web viewer for a project's runs. It serves a small HTTP API
with an event stream on `127.0.0.1`. The web page uses that API, and a native app could too
(stretch S8). Everything stays on your machine.

```sh
windtunnel view                    # in the app's folder; or --cwd zoo/shop
pnpm wt --cwd zoo/shop view        # from this checkout
```

It prints a link with a one-time token and opens it. The link signs the browser in with a
cookie; other sites can't call the viewer. Ctrl-C stops it. If a viewer is already running for
the project, running the command again prints that viewer's link. Use `--port <n>` to pick the
port (default 4477, or the next free one) and `--no-open` to skip opening the browser.

The page is built from `packages/viewer/app` with Vite into `packages/viewer/dist`. In a checkout
of this repository, `windtunnel view` builds it the first time, and rebuilds it when the sources
change. `pnpm viewer:build` builds it by hand.

## What it shows

- **Runs**, newest first, grouped by batch: runs started together by one `windtunnel run` or
  one `windtunnel_run` call. Runs appear as soon as they start, from any process (the CLI,
  your agent's MCP server, a hunt), with their repetitions counted as they finish. A run that
  stops without finishing is marked `stopped`.
- **A run**: its result and headline, version, experiment description, perturbations or
  race, how its failure was sorted, the result for each ordering (with flake rates), what was
  not exercised, and one square per repetition. Click a square to open that repetition.
- **Timeline** (aligned timelines): a column per run. Steps are lined up by tab and step name,
  each drawn on the same clock, with the requests each step sent, status codes, database
  writes, and what the harness did (held at the race barrier, response lost). By default the
  timeline compares this repetition with one that held every rule. That is another ordering
  of the same run when one passed, preferring the same ordering, else the latest passing run
  of the experiment. **Open side by side** opens any runs together, e.g. a batch's
  experiments, via the batch's **compare** link.
- **First divergence**: where this run first differs from the run that held every rule. Each
  tab's requests are compared in order. When the requests match, it shows the first request
  whose database writes differ (a duplicate webhook that wrote twice). The difference is
  marked in the timeline and summed up above the tabs.
- **Trace chain**: for the tables the broken rules read, then the others the run changed, each
  statement that wrote to them. For each one: who sent the request, the request, the handler
  file and line, the SQL with its parameters, and the result. It also shows the writers' own
  reads of the table (check-then-act shows as read, read, write, write) and payment-provider
  calls made between them. Click a statement to see all of it.
- **Database**: rows added, removed and changed against the seed data.
- **Rules**: broken rules first, with their offending rows and SQL.
- **Requests**: every request, with timings, SQL counts, handler file and harness notes. The
  race release order, charges and webhook deliveries are listed below the table.
- **Page**: where a flow failed: the error, what the page showed, the locator it waited for,
  and screenshots of each tab.
- **Log**: browser console messages and the end of the app's log.
- **Usage meter** (top right): the latest job's tool output against `budget.tokens`, and
  Level 1 spend against `budget.usd`. Click it to see every job.

## Run hunt

**Run hunt** starts Muse Code without a terminal in the app's folder:

```
muse exec --json --disable-approval --max-model-steps 80 "<prompt>"
```

The default prompt asks for the `windtunnel-hunt` skill on the area you type, and you can edit
it. The agent's JSONL events stream into the page: its messages, its tool calls (Wind Tunnel's
tools included), the token counts it reports, and its exit. The runs it starts appear on the
left as they start. **Stop** sends it SIGINT. Only one hunt runs at a time. Each hunt is kept in
`.windtunnel/logs/hunts/<id>.json` with its events in `<id>.jsonl`.

- **Billing**: the hunt uses the Meta API key in the shell that started the viewer. The button
  stays off until `MODEL_API_KEY` is set there (start the viewer in the shell where you sourced
  `scripts/muse-env.sh`) and `muse` is on that shell's `PATH`.
- **Never another agent's login**: the hunt's process gets no `ANTHROPIC_*`, `CLAUDE_*`,
  `OPENAI_*` or `CODEX_*` variables. The button refuses a `hunt.command` that runs `claude` or
  `codex`. Use **Open in Claude Code** for those.
- **Usage**: the hunt's process gets `WINDTUNNEL_JOB=hunt-<id>`, so if Muse Code passes it on
  to Wind Tunnel's MCP server, the usage meter counts the hunt as one job.
- **Event format**: Muse Code doesn't document its `--json` events. The viewer reads common
  shapes: Codex-style `item.*` events, Claude-style messages with content blocks, and flat
  `{type, text}` events. It shows anything else by its type, and shows each line as received
  under **raw events**.
- **Command**: set it in `windtunnel.config.yaml`. The prompt is added as the last argument:

  ```yaml
  hunt:
    command: [muse, exec, --json, --disable-approval, --max-model-steps, "40"]
    skill: windtunnel-hunt          # the hunt skill as the host names it
  ```

Not yet checked against a real Muse Code install: the tests use a stand-in that prints
JSONL.

## Open in Claude Code

The header's **Open in Claude Code** and each run's **Fix in Claude Code** are
[`claude-cli://` deep links](https://code.claude.com/docs/en/deep-links): they open Claude
Code in a new terminal, in the app's folder (`cwd`), with a prompt typed but not sent:

- the header link types `/windtunnel:hunt `, and you add what to hunt in;
- a run's link asks Claude Code to read that run's evidence, find the root cause, fix it and
  prove the fix.

Nothing runs until you press Enter, and it runs on your own Claude Code login, in your own
terminal. The viewer never starts Claude Code itself. The handler is registered the first time
you send a prompt in an interactive `claude` session.

## Links from agents

While a viewer is running, evidence packets end with a link to the run, for example
`Viewer: http://127.0.0.1:4477/#/run/<run>/<n>`, and the hunt skill's report includes it. The
link has no token. It opens in a browser that already has the viewer open; otherwise run
`windtunnel view` again to get a signed-in link.

## API

Every `/api` call needs the session cookie or an `x-windtunnel-token: <token>` header (the token
is in the printed link and in `.windtunnel/cache/viewer.json`, which only you can read). The
`Host` must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. A `POST`
must send JSON, and must come from the viewer's own origin when it has an `Origin` header.

| Route | Returns |
|---|---|
| `GET /api/status` | project, hunt availability per host (`hunt.hosts.muse`, `hunt.hosts.claude`, and why not), the run started from here (`jobs.running`), Level 1, budget, test users |
| `GET /api/runs?limit=` | runs newest first; unfinished ones carry `running: {done, total}` |
| `GET /api/runs/<run>` | experiment, result, repetitions, the one to show first (`focus`), the run to compare with (`reference`), failure sorting |
| `GET /api/runs/<run>/reps/<n>` | steps, requests (handler, SQL counts), rules, errors, database diff, trace chain, race, webhooks, charges, console, screenshots, app log |
| `GET /api/runs/<run>/reps/<n>/screens/<file>.jpg` | a screenshot: where the flow failed (`<tab>.jpg`), or a tab when a step ended (`step-<n>-<tab>.jpg`) |
| `GET /api/runs/<run>/evidence` | `{text}`: the evidence packet the agent gets from `windtunnel_evidence` |
| `GET /api/compare?lanes=<run>/<n>,…` | up to 8 runs: lanes, rows lined up by tab and step, the reference lane, each lane's first divergence |
| `GET /api/experiments` | every experiment (id, description, flow, users, repeat, file, perturbations) with its newest run |
| `GET /api/replay` | every experiment in the order it was first run, with its runs so far, and its newest run as the browser lived it: a lane per tab, a column per step (the same step in two tabs shares one), each step's page (path, text, screenshot), actions, harness notes and requests (grouped, with statuses, whether two tabs sent them at once and what the harness did to them), where the experiment pushed, webhook deliveries under the step they came during, the rules that broke with a sample row, and what changed in the database |
| `GET /api/map` | the app as a picture: pages (what they show, the routes they call, how the live crawl found them), routes (what each does in order, what it reads and writes, calls out, hints), tables, services; and each experiment's newest run through them: the pages and routes it reached, the tables it changed, its steps in order with each route's count and whether two were in the app at once, and where it pushes |
| `POST /api/experiments/run {experiments?, repeat?}` | runs them with the CLI (`windtunnel run`), one run at a time (409 while one goes) |
| `GET /api/jobs`, `POST /api/jobs/<id>/stop` | runs started here, with the CLI's output; stops one |
| `GET /api/usage` | budget and every job's totals |
| `GET /api/decisions` | decisions waiting for the agent |
| `GET /api/hunts`, `GET /api/hunts/<id>` | hunts, and one hunt's events |
| `POST /api/hunts {prompt, host?, model?, budgetUsd?}` | starts a hunt: `host` is `muse` (default) or `claude` (Claude Code headless on an Anthropic API key, below); 409 while one runs, 412 when the host is off |
| `POST /api/hunts/<id>/stop` | stops it |
| `GET /api/events` | server-sent events: `{type: "runs", changed: [ids]}`, `{type: "usage"}`, `{type: "hunt", id, info}`, `{type: "hunt-event", id, event}`, `{type: "job", id, info}`, `{type: "job-output", id, line}` |

The viewer polls the run store and the usage logs once a second while a page is listening, so
anything that writes them shows up without a reload.

## Without the web page: `windtunnel view --json`

The Mac app ([`apps/mac`](../apps/mac/README.md)) starts the local API with `windtunnel view --json`:
no browser and no web build, one line of JSON on stdout (`{url, port, token, pid, root, reused}`),
and the server stops when its stdin closes. With `reused: true`, a viewer for the project was
already running and the command exits at once, leaving that viewer to whoever started it.

## Claude Code as a hunt host

`POST /api/hunts` with `host: "claude"` runs Claude Code headless:
`claude -p <prompt> --bare --output-format stream-json --plugin-dir <plugin> --model <model>
--max-budget-usd <cap> --permission-mode acceptEdits --allowedTools <Wind Tunnel's tools, Read, Grep, Glob, Edit, Write>`.
It is on only when `ANTHROPIC_API_KEY` is set in the viewer's environment, and it is billed to that
key alone: `--bare` makes the key the only credential Claude Code reads (never a Claude login or
the keychain), it gets a config folder of its own (`.windtunnel/cache/claude-headless`), and every
other `ANTHROPIC_*`/`CLAUDE_*` variable and the Meta key are left out of its environment. To hunt
on your own Claude plan, use Claude Code yourself (**Open in Claude Code**): the viewer follows the
runs it starts.


# Activity log

A handoff for whoever picks up this repo next, human or coding agent. Newest first. Read
[`README.md`](README.md) for what the project is, [`plan.md`](plan.md) for the product plan,
[`execution-plan.md`](execution-plan.md) for the phases and what's still open, and
[`platforms-plan.md`](platforms-plan.md) for testing Tauri, Android, iOS and Swift Mac apps. This
file says what happened recently, why, and what to know before changing things.

## Where things stand (2026-10-30)

- `main` has Phases 1–7 done; Phase 8 (submission) is partly done.
- **[`platforms-plan.md`](platforms-plan.md)**: Phases 1 (groundwork) and 2 (Tauri) are done
  and pushed. `zoo:verify:notes` passes through both seams, no window appears during runs,
  Replay shows the Tauri runs, and there are 138 tests. Phase 3 (Android) is next. Five phases,
  one at a time: groundwork, Tauri, Android, iOS, Swift Mac apps.
- Waiting on the project owner, not on code: the Muse Code install and `pnpm bench check --paid`,
  the npm publish of `windtunnel-cli`, the demo video.
- Open after that: verify a headless Claude hunt with a real API key; an "Explain with Claude"
  panel; a test-database leak to fix; stretch items S1, S3, S5–S7 in `execution-plan.md`.

## Recent work, newest first

### Platforms Phase 2: Tauri apps, in the background

- **`crates/windtunnel-tauri`**: a Rust crate the app builds in behind a `windtunnel` cargo
  feature. Its one call replaces `builder.run(context)`. With `WINDTUNNEL_PORT` set:
  - The app's windows are created hidden on `about:blank`, and it runs with the `Prohibited`
    activation policy. That has to be set before `run()`, because Tauri's window library brings
    the app forward at launch, before plugins or `setup` run.
  - It serves the app's embedded frontend plus a stand-in for Tauri's page scripts
    (`src/tauri.js`, mirroring what `@tauri-apps/api` expects).
  - Each `invoke` arrives as `POST /__windtunnel/invoke/<command>` and goes to
    `Webview::on_message` on the main thread, with the app's invoke key.
  - Events go back as server-sent events.
- **Runner**:
  - `app.kind: tauri` drives headless WebKit and sets `WINDTUNNEL_PORT`.
  - `isolateHome` is on by default.
  - Builds share `$CARGO_TARGET_DIR` in the project cache.
  - Patterns read `invoke save_note`; calls are logged as `INVOKE save_note`.
  - The proxy treats `text/event-stream` as an event stream, so steps never wait on one.
- **`zoo/notes`**: a Tauri notes app (plain JS, no build step; SQLite seeded by `sqlite3`) with
  three bug patches and six experiments. `pnpm zoo:verify:notes` (`verify.ts --app notes`).
- **Map and scan** read `#[tauri::command]` functions (`explorer/src/tauri.ts`): SQL through
  helpers, async or main thread, events, and who invokes them.
- Evidence packets keep a value's line breaks as `\n`.
- Things to know:
  - Config commands run with the `node` on PATH, which on this Mac is nvm's Node 20 unless
    `nvm use` ran. Run the test suite with Node 24 first on PATH.
  - Headless WebKit on macOS parks a window at (-10000, -10000). It is off every display, so
    window checks have to look at bounds, not only the window list.

### Platforms Phase 1: the seam, driver, fresh state and rules work beyond the browser

Web runs the same; these are the parts the Tauri, phone and Mac phases plug into.

- **Seam** (`runner/network.ts`): the logic (patterns, perturbations, the race barrier, the
  request log, in-flight counts per `Group`) is separate from the transport that carries a
  call (`Call`: `send`, `answer`, `fulfill`, `drop`, `pass`). Transports: Playwright routes
  (`runner/route.ts`, the default) and an HTTP reverse proxy (`runner/proxy.ts`).
- **Proxy**: one per branch when asked (`--seam proxy`, `WINDTUNNEL_SEAM=proxy`); `$BASE_URL`
  and the browser go through it, webhooks and replays go straight to the app. Tabs are named
  by an `x-windtunnel-tab` header the driver sets per page. Answers carry `Connection: close`:
  Chromium silently resends a request whose reused connection resets before any answer, which
  would turn a lost response into a duplicate.
- **Driver** (`runner/driver.ts`, `runner/playwright-driver.ts`): `Rep` no longer touches
  Playwright; sessions and tabs do actions, read the screen, take screenshots.
- **Fresh state**: every run has `$DATA_DIR` (`<cache>/data/<id>`, removed with the branch);
  `app.isolateHome` points `HOME` there. `db.kind: sqlite` copies a per-version snapshot
  (`<cache>/sqlite/<version>.db`) into the folder. `db` is optional.
- **Rules**: SQLite (read-only, seed attached as `windtunnel_seed`), facts-only SQL without a
  database, and `check:` commands (`exec.ts` `runScript`). DB diff and the map's schema read
  SQLite. `app.kind` exists; only `web` runs.
- Node's `node:sqlite` is used (no new dependency), loaded only for SQLite apps.

### `1e2dc2e` Mac app: Replay, each experiment's newest run as pages on a board

- **Replay pane** (`Views/ReplayView.swift`): a row per experiment, a lane per tab, a column per
  step; each cell is the page when the step ended, what the user did and the requests it sent.
  Bands mark where the experiment pushed; the rules it broke end the row. Click a page for the
  inspector; ←/→ step through, Esc closes, pinch resizes. Launch at it with
  `--pane replay [--frame <experiment>:<n>] [--size 220]`.
- **Step screenshots** (`runner/rep.ts`): `screens/step-NN-<tab>.jpg`, JPEG quality 50, taken
  after the step's end time is set so its timing doesn't change. Runs from before this have
  none; the board shows the page text instead.
- **`GET /api/replay`** (`packages/viewer/src/replay.ts`): each experiment's newest run laid out
  as lanes, columns and frames, with its pressure placed on the columns it touched.

### `223d249` Mac app: a map of the app, and each experiment's way through it

- **Map pane**: the app's pages, the routes they call and the tables and services those reach,
  from the code, with each experiment's newest run drawn over it. Data from `GET /api/map`.

### `7fde8f2` Mac app: first run that reads your code, light mode, an overview with a chart

**First run (onboarding), two screens** (`Views/SetupView.swift`, state in `App/Setup.swift`):

1. *Pick the app*: "Which app should we try to break?", Choose Folder…, drop a folder anywhere on
   the window, recent apps. The Mac is checked in the background and shows as one line at the
   bottom ("2 things to set up on this Mac · Review"); Review opens a sheet with every check and
   **Set Up**, which runs `windtunnel install --yes` and streams its output.
2. *Read the app*: the folder's code as `windtunnel scan` reads it, before anything is set up: the
   handlers that could leave data wrong when requests overlap, each pattern in a plain sentence
   (names from the code in mono), guards it saw, and the rest listed as "Also read". On the right:
   **Open** if it has `windtunnel.config.yaml`; otherwise the coding agents with
   `/windtunnel:init` (Claude Code opens with it typed, not sent; Codex and Muse Code open in
   Terminal with it on the clipboard), and the folder is polled every 1.5 s until the config
   appears, which enables **Open**.

- First launch (no recents, `setupDone` unset) starts there. Opening a folder with no config from
  anywhere (Open Folder, recents) lands on screen 2 instead of an error. A missing Node or CLI
  opens screen 1 with the Mac sheet open.
- Launch at a screen: `open "apps/mac/build/Wind Tunnel.app" --args --setup app|read|mac [--folder <dir>]`.

**CLI** (`packages/cli`):

- `windtunnel scan [--json] [--cwd <dir>]` (`src/scan.ts`): the static half of the app map for
  any Next.js folder, with no config, build, database or model; finds the Next.js app up to two
  levels below the folder. Each flag from the explorer's `routeFlags` gets a plain sentence via
  `plain()`; an unknown flag passes through as is. Tests: `test/scan.test.ts`.
- `windtunnel install --dry-run --json` prints `{ checks, agents, steps, notes, blocked }`;
  install now detects agents that already have the plugin (Claude Code: `claude plugin list
  --json`; Codex: `codex plugin marketplace list`, which is local; Muse Code: its settings file
  and skills folder) and leaves them alone. Tests: `test/install.test.ts`.

**Overview** (`Views/OverviewView.swift`): a chart of how many experiments held and failed after
each run (replays the run list); **Failing** first, each with its broken rule, what the
experiment does (its description), its recent runs as a strip and "new" / "N in a row";
**Holding** as a two-column list; **Rules broken**. A project with no experiments shows "Start a
Hunt"; one with experiments but no runs shows **Run All**.

**Light mode**: every `Theme` colour is `Color.adaptive(dark:light:)` (an `NSColor` with a
dynamic provider); `Theme.overlay(_:)` replaces hard-coded `Color.white.opacity(…)`. Settings →
Appearance (System / Light / Dark) sets `NSApp.appearance`, so sheets, Settings and the menu bar
follow. `--appearance light|dark|system` on launch is saved as the setting.

**Removed**: all ASCII art scenes (the wind tunnel, a shape-aware ASCII renderer with a lit double
helix, and an illustrated animated explainer). The only ornament left is `Design/Glow.swift`: a
`MeshGradient` in the hue drifting very slowly in one corner under a film-grain tile, on the
start, first-run and "opening" screens only.

### `e8e90da` Mac app: a fuller overview and runs that show where to look

- Runs list: each batch shows failures first with the rule they broke; held runs fold away.
- A run opens on the answer: the rule that broke in words with its rows, where the run first went
  another way than one that held, and "Look next" links to the right tab.

### `79ec807`, `38e8cf7`, `d20fe8c`: the Mac app's first versions

The native client over the local bridge (`windtunnel view --json`), then two rounds of visual
redesign that the owner rejected in parts (see the next section).

## The owner's taste for the Mac app (read before changing its look)

This was learned over several rejected rounds; following it saves a lot of rework.

- **Rejected**: too many cards ("ai slop"), too much colour, many rounded borders, an ASCII orb,
  the ASCII wind tunnel, an ASCII double helix ("dna type thing"), ASCII-heavy onboarding
  ("monotonous"), animated mock-UI explainers ("known for ai slop"), crowded or text-heavy screens,
  an Overview that felt empty, a Runs list where it wasn't clear where to look.
- **Wanted**: premium and quiet, like a well-made native tool. Flat sections split by hairlines;
  one hue (a cool blue) with red and amber only for failed and flaky; passing runs stay grey;
  small corners; short labels with details in tooltips; SF Pro for the interface, SF Mono only
  for data. Every screen should make it obvious what to look at first.
- **Show real content** (the user's code, runs, rules, data) instead of illustrations, fake UI,
  typed-out terminals or decorative animation. Avoid stock onboarding patterns (step trails,
  "Get Started" heroes, checklists in cards).
- **Ornament**: only subtle, high-quality gradients (mesh gradient plus grain); ASCII rarely and
  only if genuinely good.
- **The product name may change**, so don't build visuals around "wind tunnel".
- Check every changed screen in a screenshot, in dark and light, before calling it done.

## Working on the Mac app

```sh
cd apps/mac
swift build                                  # quick compile check (debug)
./build.sh                                   # release .app → build/Wind Tunnel.app (repo root: pnpm mac:build)
open "build/Wind Tunnel.app" --args --project ../../zoo/shop --pane overview|runs|experiments|hunt|usage \
  [--run <run id>] [--tab summary|timeline|trace|database|network|log] [--appearance light]
open "build/Wind Tunnel.app" --args --welcome            # the start screen
open "build/Wind Tunnel.app" --args --setup read --folder <app folder>
[LIGHT=1] [T=40] .build/debug/WindTunnel --snapshot glow|parts|icon out.png 1200 760   # render a view to PNG
```

- Screenshots without Accessibility: find the window id with `CGWindowListCopyWindowInfo` (owner
  "Wind Tunnel", layer 0), then `screencapture -x -o -l <id> out.png`. `ImageRenderer` snapshots
  can't draw native controls or the window blur, so check Settings and sheets in the real app
  (a System Events keystroke ⌘, opens Settings).
- SourceKit's "cannot find X in scope" diagnostics on these files are noise; trust `swift build`.
  The Swift type checker times out on big closures with nested ternaries: move them into
  functions.
- There's no Metal toolchain on the dev Mac (Xcode 26 needs `xcodebuild -downloadComponent
  MetalToolchain`) and users won't have one, so no `.metal` shaders: use SwiftUI `MeshGradient`.
- `--run <id>` is applied after `open(project:)`, which clears the selection.
- Test launches change saved state: opened folders go into Recent (reset with `defaults write
  dev.windtunnel.mac recentProjects -array <paths>`), and `--appearance` is saved (reset with
  `defaults delete dev.windtunnel.mac appearance`).
- Live data: `zoo/shop` has about 100 real runs. Trigger a run with `POST /api/experiments/run`
  using the token in `zoo/shop/.windtunnel/cache/viewer.json` (Postgres in Docker, no model).

## Working on the rest

- Node 22.18+ (the default shell may have Node 20: use nvm's v24), pnpm 10, Docker. Postgres for
  runs is the `windtunnel-pg` container on 127.0.0.1:55432 (`pnpm db:up`).
- TypeScript runs directly on Node (type stripping): no build step in development, `.ts` import
  extensions, erasable syntax only. `pnpm cli:build` bundles the npm package.
- Checks: `pnpm typecheck`, `pnpm test`, and `node --test packages/cli/test/*.test.ts` for the CLI
  alone. `pnpm zoo:verify`, `pnpm zoo:prove` and `pnpm zoo:heal` exercise the Bug Zoo.
- Commits go straight to `main`, and only when the owner says so ("push"). End commit messages
  with the co-author line the harness gives.

## Rules that must hold (security and credentials)

- Never read, store or forward Claude or ChatGPT credentials or tokens; never read
  `~/.codex/auth.json`. Never call the Anthropic or OpenAI API with the user's login: the user's
  own unmodified CLI does all model work.
- Headless Claude runs use API keys only (`--bare`, only `ANTHROPIC_API_KEY`, an isolated
  `CLAUDE_CONFIG_DIR`), never a subscription; our code must not run `claude -p` on the user's
  subscription. The Anthropic key lives in the Keychain and only reaches the bridge's environment.
- Never click "Hunt in Claude Code" / "Open in Claude Code" or start a claude-host hunt yourself,
  and don't click **Set Up** in the Mac app's first run on the owner's machine: it changes their
  real Claude Code and Codex plugin config. Test installs only against throwaway config dirs
  (see `packages/cli/test/install.test.ts`).
- Don't run `codex plugin list`: it contacts the remote catalog with the user's login. The local
  `codex plugin marketplace list` is fine.
- Don't use `claude plugin eval`. The benchmark refuses to start `claude` or `codex` itself.
- Don't put "Claude Code" or "Anthropic" in the product name or logo.
- Keep the Muse environment variables in their own shell (`scripts/muse-env.sh`); don't use Meta
  "contributor" models with user code.
- Keep this repo self-contained: don't pull in context from the owner's other projects.
- The viewer token stays out of links given to models. Benchmark trials stay outside the repo
  with no answer leaks; scoring spends no model credits.

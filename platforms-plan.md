# Wind Tunnel beyond web apps — Plan

Last updated 2026-10-30. **Status: Phases 1 (groundwork) and 2 (Tauri) done and pushed. Phase 3
(Android) is next.**

Today Wind Tunnel tests Next.js + Postgres web apps. This plan adds Tauri apps, Android and iOS
apps on an emulator or simulator, and native Swift Mac apps, all running in the background: no
window on screen, no mouse or keyboard taken.

## Progress

| Phase | State |
|---|---|
| 1 Groundwork | Done, pushed |
| 2 Tauri | Done, pushed |
| 3 Android | Not started |
| 4 iOS | Not started |
| 5 Swift Mac apps | Not started |

What Phase 1 changed, for anyone using Wind Tunnel today:

- Web apps run exactly as before; `windtunnel run --seam proxy` (or `WINDTUNNEL_SEAM=proxy`)
  sends the browser through an HTTP proxy instead of Playwright's routes, with the same
  verdicts on the whole Bug Zoo.
- Every run has its own empty data folder, `$DATA_DIR`; `app.isolateHome: true` makes it `$HOME`
  too.
- The database can be SQLite (`db.kind: sqlite`), or there can be none.
- Rules can be SQL on SQLite, SQL on what users got and saw (with no database), or a `check:`
  command that prints the broken rows as JSON lines.
- `app.kind` names the kind of app; `web` and `tauri` run, the others wait for their phase.

What Phase 2 adds:

- `app.kind: tauri`: a Tauri v2 app runs in the background (no window, never brought forward),
  its frontend in headless WebKit, each `invoke` caught at the seam (`request: invoke
  save_note`). The app adds `crates/windtunnel-tauri` behind a cargo feature.
- `zoo/notes`, a Tauri notes app with three planted bugs; `pnpm zoo:verify:notes`.
- The Map and `windtunnel scan` read `#[tauri::command]` functions.

## The idea

A run has four parts. Today all four are built for the browser:

| Part | Today (web) | What it does |
|---|---|---|
| Driver | Playwright page (`Tab` in `runner/rep.ts`) | Does what a user does, reads the screen, takes screenshots |
| Seam | Playwright `context.route` (`runner/network.ts`) | Where a test holds, delays, doubles or drops a call; races meet here |
| Fresh state | Worktree + Postgres copy + own server (`branches/branches.ts`) | Each run starts clean |
| Rules | SQL on Postgres (`rules.ts`) | What must still be true afterwards |

Separate them, and each platform only swaps the parts that differ:

| | Driver | Seam | Fresh state | Rules |
|---|---|---|---|---|
| Web | Playwright Chromium | Playwright route | Postgres copy | SQL |
| Tauri | Playwright WebKit | `invoke` calls, relayed to the real Rust code | Data folder per run | SQL on SQLite |
| Android | Appium UiAutomator2 | HTTP proxy in front of the server | Postgres copy + app data cleared | SQL (server and phone) |
| iOS | Appium XCUITest | HTTP proxy in front of the server | Postgres copy + simulator reset | SQL (server and phone) |
| Swift Mac | Swift test scenarios | Probe points in the app's code | Data folder per run | Scripts + ThreadSanitizer |

The code reader (Map, `windtunnel scan`, the agent's hints) also needs one reader per platform.

## Rules for every phase

- Web works exactly as today. Every existing test stays green after each phase.
- Nothing appears on screen. Each phase checks it: the window list (`CGWindowListCopyWindowInfo`)
  shows no window of the app or device while experiments run.
- Test apps live in `zoo/`, with planted bugs and a patch that fixes each one, like the shop.
  Nothing from the owner's other projects is copied in. Trying Orbit (`~/orca/reco`) happens
  only when the owner asks, outside the repo.
- Tested apps may need a little dev-only code: a Tauri plugin behind a cargo feature, an API
  address read at launch, Swift probe points that do nothing in release builds. This is the
  default; the owner can say no.
- Ask before big downloads or changes to the Mac: the iOS simulator runtime (about 8 GB), new
  Android emulators, global installs.
- A phase is done when its checks pass, a Replay screenshot shows a run from that platform, the
  docs are updated, and the owner says "push".

## Phase 1 — Groundwork

Separate the four parts. No new platform yet; web runs the same.

- [x] **Seam:** split `network.ts` into the logic (request patterns, perturbations and their
  counts, the race barrier and release order, the request log) and a transport that carries
  one call: forward it, answer it, fail it, drop the answer, send it twice, hold it. The
  Playwright route becomes the first transport.
  Done: `runner/network.ts` (the logic and the `Call` interface: `send`, `answer`, `fulfill`,
  `drop`, `pass`), `runner/route.ts` (Playwright routes).
- [x] **HTTP proxy transport:** a reverse proxy in front of a run's server, one port per tab or
  device so it knows who sent what. Checked by running zoo/shop's experiments with the browser
  going through the proxy instead of the route: the same verdicts.
  Done: `runner/proxy.ts`, one per branch (`branches.create(…, { proxy: true })`); `$BASE_URL`
  is the proxy. A call names its tab in `x-windtunnel-tab` (the browser sets it per page;
  a phone will get its own port instead). Answers close the connection, so a dropped call is
  never on a reused one the client would retry. `windtunnel run --seam proxy` or
  `WINDTUNNEL_SEAM=proxy`.
- [x] **Driver:** what the runner does with a `Tab` goes through one interface: do an action, read
  what's on screen, take a screenshot, open, close. Playwright is the first driver.
  Done: `runner/driver.ts` (sessions and tabs), `runner/playwright-driver.ts`. Flows still get
  a Playwright `page`; phones add their own surface in Phase 3.
- [x] **Fresh state:** besides the Postgres copy, a data folder per run (`HOME` pointed at it),
  and a SQLite file copied per run from a snapshot built once per code version.
  Done: `$DATA_DIR` for every run, `app.isolateHome: true` for `HOME`; `db.kind: sqlite` with
  `db.file` inside the folder.
- [x] **Rules:** SQL rules run on SQLite too; `check:` rules run a script that prints the broken
  rows as JSON lines (for files and media).
  Done: SQLite read-only with the seed attached as `windtunnel_seed`; without a database, SQL
  rules on the run facts in memory; `check:` gets the facts on stdin. Database diff and the
  map's schema read SQLite too.
- [x] **Config:** `app.kind: web | tauri | android | ios | mac`, default `web`; `db` becomes
  optional so an app can have no Postgres. Other kinds are refused by `run` until their phase.

**Done when:**

- [x] `pnpm typecheck` and `pnpm test` pass: 133 tests, 0 failing.
- [x] `pnpm zoo:verify` gives the same results: PASS through the route (840 runs in 622 s).
  The clean shop and the controls pass every experiment; each case breaks its rules in every run.
- [x] The zoo/shop experiments give the same verdicts through the proxy:
  `WINDTUNNEL_SEAM=proxy pnpm zoo:verify` PASS, 840 runs in 611 s (622 s through the route),
  and its table of results is identical to the route's, line for line.
- [x] Tests for the seam logic with a fake transport, a SQLite rule and a `check:` rule:
  `network.test.ts` (fake transport), `proxy.test.ts` (against a real server), `rules.test.ts`
  (SQLite, facts only, `check:`), `sqlite-runner.test.ts` (an app on SQLite with no Postgres,
  through both seams). `runner.test.ts` also runs its 23 experiments through both seams: the
  same verdicts.
- [x] A Replay screenshot of a run that went through the proxy: the Mac app's Replay pane on
  zoo/shop after the proxy `zoo:verify` (`checkout-back-resubmit`, `"seam": "proxy"` in its
  `result.json`), every step with its screenshot and its requests under the right tab.
- [x] Docs: README (data folder, SQLite, `app.kind`), `docs/experiments.md` (SQLite and `check:`
  rules, `--seam`), the init skill, `activity.md`.
- [x] The owner says "push".

Found on the way: without `Connection: close` on the proxy's answers, Chromium silently sent a
"lost" request again on its reused connection (3 sends instead of 2), which would have turned
`lose-response` into `duplicate`. Every answer now closes its connection.

## Phase 2 — Tauri

A Tauri app is a web page talking to Rust through `invoke("save_note", …)`. Those calls are its
requests, and where its races are.

- [x] **Test app `zoo/notes`:** Tauri v2, plain TypeScript frontend, SQLite through rusqlite.
  Planted bugs, each with a fix patch: double-clicking "New note" makes two notes; autosave and
  Save at the same moment lose an edit; deleting while an autosave is in flight brings the note
  back.
  Done: `zoo/notes`. The frontend is plain JavaScript with JSDoc types (checked by `pnpm
  typecheck`) and no build step, and the seed is SQL run by macOS's `sqlite3`. That way the
  app needs no Node: config commands get whatever `node` is on PATH, which here was Node 20.
  Like the shop, the clean app is the fix and each bug is a patch in `zoo/notes/cases/`
  (`01-double-new-note`, `02-autosave-lost-edit`, `03-delete-brings-note-back`). Rules:
  `one-blank-note`, `no-lost-edit`, `deleted-notes-stay-deleted`.
- [x] **Plugin `windtunnel-tauri`** (Rust crate in this repo, behind a cargo feature in the app):
  the app runs with its window hidden; the plugin passes each `invoke` from the runner to the
  real Rust code, and its events back.
  - First check: a hidden macOS web view may slow its timers; if passing calls on is too slow,
    use a window placed off screen.
  Done: `crates/windtunnel-tauri`. It serves the app's own embedded frontend and a stand-in for
  Tauri's page scripts on `$WINDTUNNEL_PORT`. Each call is handed to `Webview::on_message` (the
  public `InvokeRequest` API, with the app's invoke key) on the main thread, so it runs the
  real command with the real state, permissions and plugins. Events come back as a server-sent
  event stream. The hidden web view isn't used at all (its windows stay on `about:blank`), so
  its timers don't matter: a call takes about 0.3 ms. The app's change is one call in place of
  `builder.run(context)`. It can't be a plugin alone, because Tauri's window library brings
  the app forward at launch, before any plugin or `setup` hook runs. So `run` sets the
  `Prohibited` activation policy between `build()` and `run()`.
- [x] **Runner:** headless Playwright WebKit loads the frontend. A script in the page provides
  `window.__TAURI_INTERNALS__`, whose `invoke` goes through the seam, then the plugin. Request
  patterns read `invoke save_note`. Two tabs are two windows on the same Rust state.
  Done: `app.kind: tauri` runs on WebKit (`browserFor` in `browser.ts`). An invoke is
  `POST /__windtunnel/invoke/<command>`, logged as `INVOKE save_note` (`callName` in
  `network.ts`). The plugin's own traffic (its script, the event stream) isn't logged. Both
  seams work, route and proxy. `new-note-two-windows` races two windows on one app.
  `windtunnel doctor` checks WebKit and cargo. Rust builds share `$CARGO_TARGET_DIR` in the
  project's cache (removed by `clean --all`), so after the first build (about 50 s) a code
  version builds in about 3.5 s.
- [x] **Fresh state:** `HOME` per run, so the app's data folder (`~/Library/Application
  Support/<id>`) is new each time, filled from a snapshot of the seeded data.
  Done: `app.isolateHome` is on by default for Tauri apps. `db.file` names the SQLite file
  under the run's HOME (`Library/Application Support/dev.windtunnel.notes/notes.db`), and it
  is copied from the version's seed snapshot.
- [x] **Code reader:** `#[tauri::command]` functions, the `invoke(...)` calls that reach them,
  and the tables they write, for the Map and `scan`.
  Done: `packages/explorer/src/tauri.ts`. For each command it reads the SQL it runs (through
  helper functions and `transaction()`), whether it is async, the events it emits, and the
  frontend lines that invoke it. The page's buttons, fields and status texts come from its HTML
  and scripts. In the Map the commands are `INVOKE <command>` routes, with an upsert hint
  (`upsert notes: writes the row whether or not it still exists`). `windtunnel scan` takes a
  Tauri folder too. Evidence packets name each call's command file.

**Done when:** each planted bug fails its experiment and passes with its fix patch, no window
appears during runs, and Replay shows a Tauri run with screenshots.

- [x] Each planted bug fails its experiment in every run, and the clean app passes every
  experiment. `pnpm zoo:verify:notes` PASSES: 72 runs in 30 s through the route, and the same
  table through the proxy (`WINDTUNNEL_SEAM=proxy`, 72 runs in 29 s). Case 01 also breaks
  `new-note-two-windows`.
- [x] No window appears during runs. While `zoo:verify:notes` ran, a watcher polled the window
  list every 100 ms. The app showed no window on any display, and the front app never changed.
  The only new window was headless WebKit's own, which Playwright parks at (-10000, -10000).
  The app runs with `ApplicationType = BackgroundOnly`.
- [x] Replay shows a Tauri run with screenshots: the Mac app's Replay pane on `zoo/notes`.
  `autosave-and-save` shows `INVOKE save_note` held for the race, and `delete-during-autosave`
  (bug 03) breaks `deleted-notes-stay-deleted` with its row and the database changes. Every
  step has its WebKit screenshot.
- [x] `pnpm typecheck` and `pnpm test` pass: 138 tests, 0 failing (run with Node 24 first on
  PATH, as `nvm use` sets it). `cargo test` in the crate passes.
- [x] The shop's `zoo:verify` gives the same results as before (web apps unchanged): PASS,
  840 runs in 632 s. The table is the same as Phase 1's, including the 3 expected errors in case
  04. After `cargo fmt` and the rebuilt patches, `zoo:verify:notes` passes again (72 runs in
  30.5 s).
- [x] Docs: README (Tauri apps, layout), `docs/experiments.md` (`invoke` patterns, Tauri apps),
  the init skill, `crates/windtunnel-tauri/README.md`, `zoo/notes/README.md`, `activity.md`.
- [x] The owner says "push".

Found on the way:
- Tauri's window library calls `activateIgnoringOtherApps` as the app finishes launching.
  Left alone, every run would have taken the keyboard from whatever the user was typing in.
- Not yet supported (in the crate's README): `Channel` arguments, `convertFileSrc` and the
  asset protocol, events aimed at one window, and windows the app creates visible after
  launch. SQLite apps have no SQL log, so their trace chain stops at the command.

## Phase 3 — Android

Most phone apps talk to a server. That half stays as it is (worktree, Postgres copy, own server,
SQL rules); only the client changes.

- [ ] **Test app `zoo/shop-android`:** a small Kotlin + Compose client of the zoo shop's API
  (log in, products, cart, pay). It reads the API address from a launch extra, and its debug
  build allows plain HTTP to localhost. The shop's own bugs and rules apply unchanged.
- [ ] **Device:** an emulator made from the installed `android-34/google_atd/arm64-v8a` image
  (made for headless tests; ask before creating it), started with `-no-window -no-audio`, kept
  running between runs. App data is cleared per run (`pm clear`). `adb reverse` lets the phone
  reach its proxy port. At most 2 emulators at once (16 GB of RAM).
- [ ] **Driver:** Appium with the UiAutomator2 driver, through webdriverio. Phone flows use a small
  API by accessibility label: `ui.tap("Pay now")`, `ui.fill("Email", …)`, `ui.see("Order
  placed")`, `ui.back()`, inside the same `step(name, …)`.
- [ ] **Phone pressures:** the app killed mid-request and reopened; sent to the background and
  back; rotated; offline during a step and back online. Network perturbations and races work
  as on the web, through the proxy; two users are two emulators.
- [ ] **Screenshots:** `adb exec-out screencap`, saved like web steps, so Replay works unchanged.

**Done when:** from the phone, double tap and lose-response break one-order-per-cart, two phones
racing break stock-non-negative, the fixes pass, no emulator window appears, and Replay shows
phone screenshots.

## Phase 4 — iOS

The same proxy and server side as Phase 3.

- [ ] **Setup:** the iOS simulator runtime (ask first, about 8 GB).
- [ ] **Test app `zoo/shop-ios`:** a small SwiftUI client of the shop's API, the same screens as
  Android; the API address comes from a launch argument.
- [ ] **Device:** `simctl boot` without Simulator.app; the app is reinstalled or the simulator
  erased per run. Data stored on the phone is a folder on the Mac (`simctl get_app_container`),
  so SQL rules can read it.
- [ ] **Driver:** Appium with the XCUITest driver and `isHeadless`. First check: no Simulator
  window opens on Xcode 26.
- [ ] **iOS pressures:** a push notification during a step (`simctl push`), a link opened twice
  (`simctl openurl`), plus the Phase 3 ones.

**Done when:** the same shop bugs fail from the simulator and pass with the fixes, no Simulator
window appears, and Replay shows iOS screenshots.

## Phase 5 — Swift Mac apps

For apps where everything happens inside the app, like a screen recorder: Stop pressed while a
frame is being written, two exports at once. There's no network call to hold, so the seam is in
the code.

- [ ] **Swift package `WindTunnelProbe`:** the app calls `await Probe.point("writer.append")` at
  the places that matter. In a run (an environment variable set) it asks the harness what to
  do: go on, wait, throw, or cancel. Otherwise, and in release builds, it does nothing.
- [ ] **Test app `zoo/recorder`:** a Swift package that copies a recorder's pipeline without
  UI: a fake frame source, an actor, a file writer. Planted bugs: Stop during a write leaves an
  unfinished file; two exports write the same temporary file; cancel during finish leaves the
  writer open.
- [ ] **Runner:** `app.kind: mac`. An experiment names a Swift test as its scenario (`swift test
  --filter`, or `xcodebuild test -only-testing` for an Xcode project). Races and perturbations
  target probe points: `race: { point: writer.append, order: each }`, `perturb: [{ do: fail,
  point: export.finish }]`. Each run gets its own data folder.
- [ ] **Rules:** `check:` scripts on what's left (the exported video opens and has the right
  length); builds with ThreadSanitizer, where any data race it reports breaks a `no-data-races`
  rule, with both stacks as the sample.
- [ ] **Code reader:** actors, `Task {}` and `Task.detached`, dispatch queues, AVAssetWriter and
  file writes, listed as places to put probe points; the agent proposes them.

**Done when:** each planted bug fails its experiment and passes with its fix patch, tests run
with nothing on screen, and Replay shows the scenario's steps.

## Later

- The real Tauri window, through a WebDriver server embedded as a plugin (Tauri's own
  `tauri-driver` doesn't support macOS); a Linux container for Tauri apps that build there.
- Driving a Mac app's real UI: on this Mac through Accessibility (it leaves the mouse and
  keyboard alone, but windows exist), or fully hidden in a macOS virtual machine.
- Code readers for the API calls in Kotlin and Swift clients; notes for Flutter and React
  Native apps.

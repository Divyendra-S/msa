# Wind Tunnel beyond web apps — Plan

Last updated 2026-10-30. **Status: Phase 1 is next; nothing started.**

Today Wind Tunnel tests Next.js + Postgres web apps. This plan adds Tauri apps, Android and iOS
apps on an emulator or simulator, and native Swift Mac apps, all running in the background: no
window on screen, no mouse or keyboard taken.

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

- [ ] **Seam:** split `network.ts` into the logic (request patterns, perturbations and their
  counts, the race barrier and release order, the request log) and a transport that carries
  one call: forward it, answer it, fail it, drop the answer, send it twice, hold it. The
  Playwright route becomes the first transport.
- [ ] **HTTP proxy transport:** a reverse proxy in front of a run's server, one port per tab or
  device so it knows who sent what. Checked by running zoo/shop's experiments with the browser
  going through the proxy instead of the route: the same verdicts.
- [ ] **Driver:** what the runner does with a `Tab` goes through one interface: do an action, read
  what's on screen, take a screenshot, open, close. Playwright is the first driver.
- [ ] **Fresh state:** besides the Postgres copy, a data folder per run (`HOME` pointed at it),
  and a SQLite file copied per run from a snapshot built once per code version.
- [ ] **Rules:** SQL rules run on SQLite too; `check:` rules run a script that prints the broken
  rows as JSON lines (for files and media).
- [ ] **Config:** `app.kind: web | tauri | android | ios | mac`, default `web`; `db` becomes
  optional so an app can have no Postgres.

**Done when:** `pnpm typecheck` and `pnpm test` pass, `pnpm zoo:verify` gives the same results,
the zoo/shop experiments give the same verdicts through the proxy, and there are tests for the
seam logic with a fake transport, a SQLite rule and a `check:` rule.

## Phase 2 — Tauri

A Tauri app is a web page talking to Rust through `invoke("save_note", …)`. Those calls are its
requests, and where its races are.

- [ ] **Test app `zoo/notes`:** Tauri v2, plain TypeScript frontend, SQLite through rusqlite.
  Planted bugs, each with a fix patch: double-clicking "New note" makes two notes; autosave and
  Save at the same moment lose an edit; deleting while an autosave is in flight brings the note
  back.
- [ ] **Plugin `windtunnel-tauri`** (Rust crate in this repo, behind a cargo feature in the app):
  the app runs with its window hidden; the plugin passes each `invoke` from the runner to the
  real Rust code, and its events back.
  - First check: a hidden macOS web view may slow its timers; if passing calls on is too slow,
    use a window placed off screen.
- [ ] **Runner:** headless Playwright WebKit loads the frontend. A script in the page provides
  `window.__TAURI_INTERNALS__`, whose `invoke` goes through the seam, then the plugin. Request
  patterns read `invoke save_note`. Two tabs are two windows on the same Rust state.
- [ ] **Fresh state:** `HOME` per run, so the app's data folder (`~/Library/Application
  Support/<id>`) is new each time, filled from a snapshot of the seeded data.
- [ ] **Code reader:** `#[tauri::command]` functions, the `invoke(...)` calls that reach them,
  and the tables they write, for the Map and `scan`.

**Done when:** each planted bug fails its experiment and passes with its fix patch, no window
appears during runs, and Replay shows a Tauri run with screenshots.

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

---
name: init
description: "Set up Wind Tunnel for this app: write windtunnel.config.yaml and a login flow, check the build, map the app."
---

# Set up Wind Tunnel

Wind Tunnel runs the app in isolated copies (git worktree + its own Postgres database copy + app process) and drives it with Playwright. It needs one config file at the app's root: `windtunnel.config.yaml`. Supported today: Next.js web apps (Postgres, SQLite or no database), Tauri v2 desktop apps, Android apps (Kotlin, on headless emulators) and iOS apps (Swift, on simulators) with their server, and the code of Swift Mac apps (a Swift package or an Xcode project, driven by its XCTest methods).

## 1. Read the repo (don't ask what you can find)

Look at `package.json` scripts, the lockfile, `.env.example`/`.env.local`, `docker-compose.yml`, migration and seed scripts (Prisma, Drizzle, plain SQL), and how the app reads its database URL and any payment provider settings. Find test users: seeded accounts with known passwords.

## 2. Write the config

```yaml
app:
  install: pnpm install --frozen-lockfile   # optional; detected from the lockfile
  build: pnpm build                         # optional
  start: pnpm start --port $PORT            # must listen on $PORT
  baseUrl: http://127.0.0.1:$PORT
  ready: /                                  # path polled until it answers < 500 (an /api/health route is best)
  env:                                      # extra env for the app; these are filled in per copy:
    DATABASE_URL: $DATABASE_URL             #   $PORT $BASE_URL $DATABASE_URL $MOCK_PAY_URL $MOCK_PAY_SECRET
db:
  kind: postgres
  url: postgres://postgres:postgres@127.0.0.1:5432/postgres   # any database on a local Postgres server; copies are created next to it
  seed: pnpm db:migrate && pnpm db:seed     # fills the empty $DATABASE_URL: schema + seed data
mockPay:                                    # only if the app takes payments
  webhookPath: /api/webhooks/payment        # where the app receives payment webhooks
users:                                      # test accounts that exist after the seed
  alice: { email: alice@example.test, password: test }
  bob: { email: bob@example.test, password: test }
parallel: 4
crawl:                                      # optional: who the crawl visits as (default: the first user)
  users: [alice]
```

Rules for a good config:
- The seed must be deterministic: same data every time, no random ids or dates that matter.
- Two users at least, so experiments can test two buyers or another user's data. If the seed has none, propose adding test users to it.
- Never point `db.url` at a shared or production database. Wind Tunnel creates and drops databases on that server.
- A Tauri v2 app (a `src-tauri/` folder): `app.kind: tauri`. Add `crates/windtunnel-tauri` from the Wind Tunnel repo behind a `windtunnel` cargo feature, and replace `builder.run(context)` with `windtunnel_tauri::run(builder, context)` under that feature (its README has the lines; propose them, they are the only change to the app). `build` runs `cargo build --features windtunnel` and copies `$CARGO_TARGET_DIR/debug/<binary>` into the app folder; `start` runs that copy. The database is usually SQLite under `app_data_dir()`: `db.file: Library/Application Support/<identifier>/<file>.db`, since each run's `$HOME` is its own folder. Flows are the same Playwright flows; request patterns are `invoke <command>`.
- An Android app (an `AndroidManifest.xml`, Gradle): `app.kind: android`. `app` describes its server as for a web app, with `app.dir` pointing at the server's folder (`../server`); `android.package` is the application id, and `android.extras` passes the server's address as a launch extra (`apiUrl: $BASE_URL`). Propose reading that extra in the app's debug build, and allowing plain HTTP to `127.0.0.1` there (a debug `network_security_config.xml`): those are the only changes to the app. Flows are `phoneFlow`s: `ui.tap("Pay now")`, `ui.fill("Email", user.email)`, `ui.see("Order confirmed")`, by the text or accessibility label the user reads; give repeated buttons their own `contentDescription`. `windtunnel doctor` checks the SDK, the AVD (`windtunnel devices create`), a JDK and Appium (`npm i -D appium appium-uiautomator2-driver webdriverio`). Phone pressures: `kill-app`, `background`, `rotate`, `offline`.
- An iOS app (an `.xcodeproj` and Swift sources): `app.kind: ios`, with its server in `app` as for Android. `ios.bundleId` is the bundle identifier; `ios.arguments` passes the server's address as a launch argument (`[-apiUrl, $BASE_URL]`, read with `UserDefaults.standard.string(forKey: "apiUrl")`). Propose reading it in the app and allowing plain HTTP to this Mac (`NSAppTransportSecurity` / `NSAllowsLocalNetworking`). If the build needs a scheme or isn't the project's first target, set `ios.build` (it must leave one simulator `.app` under `build/`, or set `ios.app`). Flows are the same `phoneFlow`s; give repeated buttons their own `accessibilityLabel`. `windtunnel doctor` checks Xcode, an iOS simulator runtime, the simulators (`windtunnel devices create`) and WebDriverAgent (`npm i -D appium-webdriveragent`). iOS adds `push` (a notification during a step) and `ui.openLink(url)`; a rule with `phone: <path>` runs its SQL on the app's own SQLite file on each phone.
- A Swift Mac app (a `Package.swift`, no server): `app.kind: mac`, and no `app.start`. Its code is tested as that package: each experiment names an XCTest method as its `scenario` (`RecorderScenarios/testRecordAndStop`) instead of a flow, and each run starts it alone, in its own empty `$DATA_DIR` (also `$HOME`; `Probe.dataDirectory` in Swift). Propose adding `swift/WindTunnelProbe` to the package, and probe points where runs should step in: `try await Probe.point("writer.finish")` in front of an `await` the code already makes (a stop, a finish, a write, a hand-off between tasks); `windtunnel map` lists actors, tasks, dispatch queues, unchecked shared state, file writes and cancellation checks as candidates. Ask before editing the app's code. Mark the scenario's steps with `Probe.step("stop") { … }`. Pressure goes on points: `delay`, `fail` (the point throws), `cancel` (the task is cancelled there), and races (`race: { point: export.encode, order: each }`). Rules are `check:` commands on the files the run left, and `no-data-races: { sanitizer: thread }` with ThreadSanitizer (`mac.sanitizer: thread`, the default). `windtunnel doctor` checks Xcode, xctest and whether ThreadSanitizer runs: on macOS 26.4+ it needs Xcode 26.4+, else set `mac.sanitizer: none` and say so. An Xcode project (an `.xcodeproj` and no `Package.swift`): set `mac.project` and `mac.scheme`; its tests run inside the app, so propose `Probe.hostScenario()` as the first line of the app's entry point (each run then starts the app's executable, which runs the scenario in place of the app, with nothing on screen), and adding `swift/WindTunnelProbe` as a local package to the app's target. Scenarios are XCTest classes in the test target (it can `import WindTunnelProbe` without linking it); have each write what the user was told into `Probe.dataDirectory`, for `check:` rules to compare with the files.
- An app on SQLite: `db: { kind: sqlite, file: app.db, seed: <command> }`. Each run gets its own copy of the seeded file inside its data folder; point the app at `$DATABASE_PATH` (or `$DATABASE_URL`, `file:<path>`) in `app.env`. An app with no database leaves `db` out.
- If the app calls a payment provider, point its base URL at `$MOCK_PAY_URL` and its webhook secret at `$MOCK_PAY_SECRET` in `app.env`. The mock speaks a Stripe-like API (`POST /v1/charges` with `idempotency-key`, signed webhooks in a `mockpay-signature: t=…,v1=<hmac-sha256 of "t.body">` header). If the app's client can't talk to it, leave `mockPay` out and say so.

Show the user the config and what you assumed in one short message, and ask once before writing it.

## 3. Login flow

If the app has a login, write `.windtunnel/flows/login.ts`. Experiments use it through `login()`:

```ts
import { flow } from "windtunnel";

export default flow(async ({ page, user }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL("/");
});
```

Use the real labels and button names from the login page.

## 4. Check it

1. Call `windtunnel_validate`. The first call builds the app and the seed snapshot, which can take a minute. Fix what it reports.
2. Call `windtunnel_branch` with `action: "start"`, open the printed app URL with curl (or log in with the login flow through a run), then stop the branch.
3. Call `windtunnel_map` with `crawl: true`. It runs the app and visits its pages as an anonymous visitor and as a test user (links only: no forms submitted, and on a database copy anyway), so the map gains the real names of buttons, links and fields, and the free sweep: console errors, failed requests, broken links, accessibility problems and slow pages, found with no model. Summarise for the user in a few lines: routes, flagged patterns, tables, and any sweep findings (`windtunnel_evidence` with handle `sweep` lists them all).

Finish by suggesting the hunt skill on the riskiest area the map shows (often checkout or anything that takes payments).

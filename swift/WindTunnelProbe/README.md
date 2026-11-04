# WindTunnelProbe

Probe points for Swift apps: the places in the code where a Wind Tunnel run can step in. At
each point, the run decides whether the code goes on, waits, throws, or has its task cancelled.
Races are made of the same points: two exports held as they reach the encoder, then let go in
every order.

None of this happens outside a run. Without `WINDTUNNEL_PROBE` in the environment, and in
release builds, a point returns at once without suspending, and a step only runs its code. The
harness answers anyone on 127.0.0.1, so it is for test runs only.

## Add it to a package

```swift
// Package.swift
dependencies: [
    .package(path: "<path to this folder>"),
],
targets: [
    .target(name: "Recorder", dependencies: [.product(name: "WindTunnelProbe", package: "WindTunnelProbe")]),
    .testTarget(name: "RecorderScenarios", dependencies: ["Recorder", .product(name: "WindTunnelProbe", package: "WindTunnelProbe")]),
]
```

It needs Swift 6, macOS 13 or iOS 16.

## Points

```swift
import WindTunnelProbe

actor TakeWriter {
    func append(_ frame: Frame) async throws {
        try await Probe.point("frame.compress")
        let payload = await compress(frame.pixels)
        …
    }
}
```

Put a point in front of an `await` the code already makes. Holding the point then only widens a
window that is already there: while it waits, the actor is free, as it is during the `await`.
An experiment names the point (`point: frame.compress`):

- `delay`: the code waits there, then goes on.
- `fail`: the point throws `ProbeError`.
- `cancel`: the point cancels the current task and returns. The code finds out at its next
  cancellation check, as it would if the user had cancelled at that moment.

A point can cover a section of code:

```swift
try await Probe.point("writer.finish") {
    try await writer.finish()
}
```

In a race whose points go one at a time, the next one goes only after this section has
finished. A bare point counts as finished as soon as it goes on.

## Scenarios

Wind Tunnel runs one XCTest method per run: the experiment's `scenario`. Its steps are what
Replay shows as columns:

```swift
final class RecorderScenarios: XCTestCase {
    func testRecordAndStop() async throws {
        let recorder = Recorder(directory: Probe.dataDirectory)
        try await Probe.step("start") { try await recorder.start(take: "take-1") }
        …
    }
}
```

`Probe.dataDirectory` is the run's own empty folder (`DATA_DIR`), or the temporary folder
outside a run.

A step can show what the user would see at its end, which Replay shows as the step's screenshot,
with the probe points under it:

```swift
await Probe.step("export", showing: { ExportPage(editor: editor, session: session) }) {
    session.start()
}
```

In a run, once the step's code has run (or failed), the view is drawn in a window that is never put
on screen, and sent to the run as a JPEG: 1280×800 points by default (`size:`), drawn at twice that
in pixels so it stays sharp when Replay's player shows it large. A step without `showing:` shows the
probe points its code reached instead, so give every step the user would see a view:

- **Video players:** an `AVPlayerLayer` sends its picture straight to the screen. The drawing
  shows the player's current frame instead, through its item's video composition.
- **Glass and blur:** Liquid Glass and blur-behind layers show what's behind them, which an
  off-screen window doesn't have. They're left out, and the window's ground shows instead.
- **Windows stay open:** each picture's window stays open until the scenario ends, as a window
  the user leaves open. A view that acts as it disappears (an export page that cancels its export)
  would otherwise act on the code under test.
- **Cost:** a picture takes about half a second, during which the scenario waits and the app's
  own work goes on. Leave room in a scenario that races the clock.

Outside a run, and in release builds, the view is never made.

## Xcode projects

An Xcode project's tests usually run inside its app (`TEST_HOST`). Add this folder as a local
package to the app's target (File → Add Package Dependencies → Add Local). Wind Tunnel builds
each version from a copy of the repository elsewhere, so a path outside the repository must be
absolute. Then call `Probe.hostScenario()` first thing in the app's entry point:

```swift
@main
enum AppMain {
    static func main() {
        Probe.hostScenario()   // a Wind Tunnel run: runs its scenario in place of the app, then exits
        MyApp.main()
    }
}
```

For each run, Wind Tunnel starts the app's executable with the test to run
(`WINDTUNNEL_SCENARIO`), the test bundle and XCTest's library. `hostScenario()` loads them, runs
that one test, and exits with its result, before the app has shown anything: no window, menu bar
item or Dock icon. It points `UserDefaults.standard` at a file in the run's folder, so the
scenario never reads or writes the app's real settings. While a point is still held when the
test returns (work the test didn't wait for), the app keeps running until it's let go, and a
moment after. Elsewhere, and in release builds, it returns at once.

The test target can `import WindTunnelProbe` without linking it: its code comes from the app it
runs in.

A held point stays held when its task is cancelled meanwhile: the run lets it go, as the `await`
it stands for would have finished.

## How it talks to the run

`WINDTUNNEL_PROBE` is the harness's address, on this Mac. Each request is JSON:

- `POST /point {name, section}`: the answer comes when the run decides. It is
  `{"do": "go" | "throw" | "cancel", "id"?}`.
- `POST /done {id}`: a section has finished.
- `POST /step {name, phase: "start" | "end", error?}`: marks a step of the scenario.

If the harness can't be reached, the point writes a warning to stderr and goes on.

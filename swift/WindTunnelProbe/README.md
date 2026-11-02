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

## How it talks to the run

`WINDTUNNEL_PROBE` is the harness's address, on this Mac. Each request is JSON:

- `POST /point {name, section}`: the answer comes when the run decides. It is
  `{"do": "go" | "throw" | "cancel", "id"?}`.
- `POST /done {id}`: a section has finished.
- `POST /step {name, phase: "start" | "end", error?}`: marks a step of the scenario.

If the harness can't be reached, the point writes a warning to stderr and goes on.

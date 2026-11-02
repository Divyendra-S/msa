import Recorder
import WindTunnelProbe
import XCTest

/// What a user does with the recorder, as Wind Tunnel runs it: each test is a scenario, its steps
/// marked for Replay. The rules (.windtunnel/rules.yaml) check the files it leaves in the run's
/// own folder.
final class RecorderScenarios: XCTestCase {
    /// Record, and press Stop while frames are still coming in.
    func testRecordAndStop() async throws {
        let recorder = Recorder(directory: Probe.dataDirectory)
        try await Probe.step("start") {
            try await recorder.start(take: "take-1")
        }
        let feeding = try await Probe.step("record") {
            let feeding = Task { await Self.feed(recorder, frames: 10) }
            try await Task.sleep(for: .milliseconds(60))
            return feeding
        }
        // Stop runs in a task of its own, as a button's action does; closing the window cancels it.
        try await Probe.step("stop") {
            try await Task { try await recorder.stop() }.value
        }
        await feeding.value
    }

    /// Record a short take, then export it twice at once: full size and half size.
    func testTwoExports() async throws {
        let directory = Probe.dataDirectory
        let recorder = Recorder(directory: directory)
        try await Probe.step("record") {
            try await recorder.start(take: "take-1")
            for index in 0..<6 {
                try await recorder.append(Frame(index: index))
            }
            try await recorder.stop()
        }
        let take = directory.appendingPathComponent("take-1.take")
        let exporter = Exporter(directory: directory)
        try await Probe.step("export") {
            async let full: Void = exporter.export(take, to: directory.appendingPathComponent("take-1-full.export"), preset: .full)
            async let half: Void = exporter.export(take, to: directory.appendingPathComponent("take-1-half.export"), preset: .half)
            _ = try await (full, half)
        }
    }

    /// Frames from the fake capture device, appended as they come until the recorder stops.
    private static func feed(_ recorder: Recorder, frames count: Int) async {
        let source = FrameSource(stats: recorder.stats)
        for await frame in source.frames(count: count, every: 0.005) {
            do {
                try await recorder.append(frame)
            } catch {
                return
            }
        }
    }
}

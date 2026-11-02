import Foundation
import WindTunnelProbe

public enum RecorderError: Error {
    case alreadyRecording
    case notRecording
}

/// Records takes: Start opens a take, frames are appended as they come, Stop finishes it.
public actor Recorder {
    public let directory: URL
    public nonisolated let stats = FrameStats()
    private var writer: TakeWriter?

    public init(directory: URL) {
        self.directory = directory
    }

    public var isRecording: Bool {
        writer != nil
    }

    public func start(take name: String) throws {
        guard writer == nil else { throw RecorderError.alreadyRecording }
        let url = directory.appendingPathComponent("\(name).take")
        writer = try TakeWriter(url: url, partial: url.appendingPathExtension("partial"))
    }

    public func append(_ frame: Frame) async throws {
        guard let writer else { throw RecorderError.notRecording }
        // A recorder that falls far behind skips frames rather than lag further.
        if stats.backlog > 30 {
            stats.didSkip()
            return
        }
        try await writer.append(frame)
        stats.didWrite()
    }

    /// Stops recording and finishes the take. Frames still on their way are dropped.
    public func stop() async throws {
        guard let writer else { throw RecorderError.notRecording }
        self.writer = nil
        try await Probe.point("writer.finish") {
            try await writer.finish()
        }
    }
}

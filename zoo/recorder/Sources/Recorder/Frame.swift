import Foundation

/// One captured frame: its number, and a few bytes standing in for its pixels.
public struct Frame: Sendable {
    public let index: Int
    public let pixels: Data

    public init(index: Int) {
        self.init(index: index, pixels: Data("frame \(index) ".utf8) + Data(repeating: UInt8(ascii: "a") + UInt8(index % 26), count: 40))
    }

    public init(index: Int, pixels: Data) {
        self.index = index
        self.pixels = pixels
    }
}

/// Counts what the capture side and the recorder did. The capture queue and the recorder's actor
/// both use it, so every access takes the lock.
public final class FrameStats: @unchecked Sendable {
    private let lock = NSLock()
    private var captured = 0
    private var written = 0
    private var skipped = 0

    public init() {}

    func didCapture() {
        lock.withLock { captured += 1 }
    }

    func didWrite() {
        lock.withLock { written += 1 }
    }

    func didSkip() {
        lock.withLock { skipped += 1 }
    }

    /// Frames captured and not yet written or skipped.
    public var backlog: Int {
        lock.withLock { captured - written - skipped }
    }
}

/// A fake capture device: delivers frames on its own queue at a steady pace, like a screen
/// capture callback.
public final class FrameSource: Sendable {
    private let queue = DispatchQueue(label: "dev.windtunnel.recorder.capture")
    private let stats: FrameStats

    public init(stats: FrameStats) {
        self.stats = stats
    }

    public func frames(count: Int, every interval: TimeInterval) -> AsyncStream<Frame> {
        let stats = stats
        return AsyncStream { continuation in
            queue.async {
                for index in 0..<count {
                    stats.didCapture()
                    continuation.yield(Frame(index: index))
                    Thread.sleep(forTimeInterval: interval)
                }
                continuation.finish()
            }
        }
    }
}

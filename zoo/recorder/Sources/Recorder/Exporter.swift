import Foundation
import WindTunnelProbe

/// Exports a take at a preset, as a new take: each frame converted and encoded, the whole
/// written next to the destination first and moved into place when finished.
public struct Exporter: Sendable {
    public enum Preset: String, Sendable {
        /// Every byte.
        case full
        /// Every other byte, a smaller file.
        case half

        func convert(_ pixels: Data) -> Data {
            switch self {
            case .full: pixels
            case .half: Data(pixels.enumerated().compactMap { $0.offset % 2 == 0 ? $0.element : nil })
            }
        }
    }

    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    public func export(_ take: URL, to destination: URL, preset: Preset) async throws {
        let frames = try TakeFile(contentsOf: take).frames
        let writer = try TakeWriter(
            url: destination,
            partial: destination.appendingPathExtension("partial"),
            header: " source=\(take.lastPathComponent) preset=\(preset.rawValue)"
        )
        // The encoder reads each frame from a file, as an external one does: this export's own.
        let scratch = destination.appendingPathExtension("scratch")
        defer { try? FileManager.default.removeItem(at: scratch) }
        for frame in frames {
            try preset.convert(frame.pixels).write(to: scratch)
            try await Probe.point("export.encode")
            try await writer.append(Frame(index: frame.index, pixels: try await encode(scratch)))
        }
        try await writer.finish()
    }
}

/// Encodes a frame from its file, away from the caller (here the bytes stay as they are).
private func encode(_ file: URL) async throws -> Data {
    try Data(contentsOf: file)
}

import Foundation
import WindTunnelProbe

public enum TakeError: Error, Equatable {
    /// The take was finished, or never opened.
    case closed
    /// The file isn't a take, or isn't whole.
    case unreadable(String)
}

/// Writes a take: a header line, a record per frame, then an index that counts the frames. Until
/// it is finished the take is a `.partial` file next to it; a take without its index can't be
/// opened.
actor TakeWriter {
    let url: URL
    private let partial: URL
    private let handle: FileHandle
    private var count = 0
    private var closed = false

    /// Opens the take's `.partial` file, from the start: one left by an earlier attempt is reused.
    init(url: URL, partial: URL, header: String = "") throws {
        self.url = url
        self.partial = partial
        if !FileManager.default.fileExists(atPath: partial.path) {
            guard FileManager.default.createFile(atPath: partial.path, contents: nil) else {
                throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: partial.path])
            }
        }
        handle = try FileHandle(forWritingTo: partial)
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: Data("WTAKE 1\(header)\n".utf8))
    }

    /// Compresses a frame, then writes its record in one go.
    func append(_ frame: Frame) async throws {
        try await Probe.point("frame.compress")
        let payload = await compress(frame.pixels)
        guard !closed else { throw TakeError.closed }
        var record = Data("F \(frame.index) \(payload.count)\n".utf8)
        record.append(payload)
        record.append(UInt8(ascii: "\n"))
        try handle.write(contentsOf: record)
        count += 1
    }

    /// Writes the index and closes the take. A take without its index can't be opened, so this
    /// runs to the end even when the task that asked for it is cancelled.
    func finish() async throws {
        try await Task { try await self.save() }.value
    }

    private func save() async throws {
        guard !closed else { return }
        // Waits for what was written to reach the disk, as a movie writer's finish does.
        try handle.synchronize()
        try await Task.sleep(for: .milliseconds(5))
        try handle.write(contentsOf: Data("INDEX \(count)\nEND\n".utf8))
        try handle.close()
        closed = true
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: partial, to: url)
    }
}

/// Compresses a frame's pixels away from the writer's actor, where a real encoder would work
/// (here the bytes stay as they are).
private func compress(_ pixels: Data) async -> Data {
    pixels
}

/// A take on disk, read back: its header and its frames.
struct TakeFile {
    let header: String
    let frames: [Frame]

    init(contentsOf url: URL) throws {
        let data = try Data(contentsOf: url)
        var at = data.startIndex
        func line() throws -> String {
            guard let end = data[at...].firstIndex(of: UInt8(ascii: "\n")) else { throw TakeError.unreadable("\(url.lastPathComponent): a line without its end") }
            defer { at = end + 1 }
            return String(decoding: data[at..<end], as: UTF8.self)
        }
        header = try line()
        guard header.hasPrefix("WTAKE 1") else { throw TakeError.unreadable("\(url.lastPathComponent) is not a take") }
        var frames: [Frame] = []
        while true {
            let fields = try line().split(separator: " ")
            if fields.first == "INDEX" {
                guard fields.count == 2, Int(fields[1]) == frames.count, try line() == "END" else {
                    throw TakeError.unreadable("\(url.lastPathComponent): its index doesn't match its frames")
                }
                break
            }
            guard fields.count == 3, fields[0] == "F", let index = Int(fields[1]), let length = Int(fields[2]), at + length < data.endIndex else {
                throw TakeError.unreadable("\(url.lastPathComponent): a broken frame record")
            }
            frames.append(Frame(index: index, pixels: data[at..<(at + length)]))
            at += length + 1
        }
        self.frames = frames
    }
}

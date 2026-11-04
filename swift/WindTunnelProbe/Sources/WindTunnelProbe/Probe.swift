import Foundation
#if DEBUG
import os
#endif

/// The places in an app's code where a Wind Tunnel run can step in, and the steps of a test
/// scenario.
///
/// In a run, `WINDTUNNEL_PROBE` names the harness, and each point asks it what to do: go on,
/// wait, throw ``ProbeError``, or cancel the current task. Outside a run, and in release builds,
/// every call does nothing: a point returns at once, without suspending.
public enum Probe {
    /// A place where a run can step in: before a write, a finish, a hand-off between tasks. Put
    /// it in front of an `await` the code already makes, so a held point only widens a window
    /// that is there anyway.
    ///
    /// When the run cancels the task here, the point returns and the code finds out at its next
    /// cancellation check, as it would if the user had cancelled it at that moment.
    public static func point(_ name: String, isolation: isolated (any Actor)? = #isolation) async throws {
        #if DEBUG
        guard let harness = Harness.shared else { return }
        _ = try await harness.ask(name, section: false)
        #endif
    }

    /// A point that covers a section of code. In a race released one at a time, the next point
    /// goes on once this section has finished.
    public static func point<T>(
        _ name: String,
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async throws -> T {
        #if DEBUG
        guard let harness = Harness.shared else { return try await body() }
        let id = try await harness.ask(name, section: true)
        do {
            let value = try await body()
            await harness.done(id, error: nil)
            return value
        } catch {
            await harness.done(id, error: error)
            throw error
        }
        #else
        return try await body()
        #endif
    }

    /// A step of a test scenario. Replay shows a column per step, with the points reached during
    /// it, and an experiment can aim at the points of one step (`step: stop`).
    public static func step<T>(
        _ name: String,
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async rethrows -> T {
        #if DEBUG
        guard let harness = Harness.shared else { return try await body() }
        await harness.step(name, phase: "start", error: nil)
        do {
            let value = try await body()
            await harness.step(name, phase: "end", error: nil)
            return value
        } catch {
            await harness.step(name, phase: "end", error: error)
            throw error
        }
        #else
        return try await body()
        #endif
    }

    /// The run's own folder for files (`DATA_DIR`), empty when the run starts; the temporary
    /// folder outside a run.
    public static var dataDirectory: URL {
        if let dir = ProcessInfo.processInfo.environment["DATA_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        return FileManager.default.temporaryDirectory
    }

    /// Whether a run is listening (`WINDTUNNEL_PROBE` is set in a debug build).
    public static var isActive: Bool {
        #if DEBUG
        return Harness.shared != nil
        #else
        return false
        #endif
    }
}

/// What a point throws when the run fails the code there.
public struct ProbeError: Error, CustomStringConvertible {
    public let point: String

    public var description: String { "Wind Tunnel failed \(point) on purpose" }
}

#if DEBUG
/// The harness the points talk to, over HTTP on this Mac.
final class Harness: Sendable {
    static let shared: Harness? = {
        guard let value = ProcessInfo.processInfo.environment["WINDTUNNEL_PROBE"], let url = URL(string: value) else { return nil }
        return Harness(base: url)
    }()

    private let base: URL
    private let session: URLSession
    /// Points waiting for the run's answer right now.
    private let waiting = OSAllocatedUnfairLock(initialState: 0)

    /// Whether any point is waiting for the run's answer.
    var isHolding: Bool {
        waiting.withLock { $0 > 0 }
    }

    private init(base: URL) {
        self.base = base
        let configuration = URLSessionConfiguration.ephemeral
        // A point can be held at a race barrier, or delayed, for as long as the run says.
        configuration.timeoutIntervalForRequest = 600
        configuration.timeoutIntervalForResource = 600
        // Every task held at once has a request open.
        configuration.httpMaximumConnectionsPerHost = 64
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    private struct Reply: Decodable {
        let action: String
        let id: Int?

        enum CodingKeys: String, CodingKey {
            case action = "do"
            case id
        }
    }

    /// Asks what to do at a point, and does it; returns the section's id for `done`.
    func ask(_ name: String, section: Bool) async throws -> Int? {
        waiting.withLock { $0 += 1 }
        defer { waiting.withLock { $0 -= 1 } }
        let reply: Reply
        do {
            reply = try JSONDecoder().decode(Reply.self, from: await post("point", ["name": name, "section": section]))
        } catch {
            warn("point \(name): \(error.localizedDescription); going on")
            return nil
        }
        switch reply.action {
        case "throw":
            throw ProbeError(point: name)
        case "cancel":
            withUnsafeCurrentTask { $0?.cancel() }
        default:
            break
        }
        return reply.id
    }

    func done(_ id: Int?, error: (any Error)?) async {
        guard let id else { return }
        var body: [String: Any] = ["id": id]
        if let error { body["error"] = String(describing: error) }
        _ = try? await post("done", body)
    }

    func step(_ name: String, phase: String, error: (any Error)?, picture: Data? = nil) async {
        var body: [String: Any] = ["name": name, "phase": phase]
        if let error { body["error"] = String(describing: error) }
        if let picture { body["picture"] = picture.base64EncodedString() }
        _ = try? await post("step", body)
    }

    private func post(_ path: String, _ body: [String: Any]) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        // Detached, so a held point stays held when its task is cancelled meanwhile: the run lets it
        // go, as the await it stands for would have finished.
        let session = session
        let finalRequest = request
        return try await Task.detached {
            let (data, response) = try await session.data(for: finalRequest)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            return data
        }.value
    }

    private func warn(_ text: String) {
        FileHandle.standardError.write(Data("WindTunnelProbe: \(text)\n".utf8))
    }
}

#endif

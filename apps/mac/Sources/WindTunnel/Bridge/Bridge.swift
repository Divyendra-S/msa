import Foundation

/// What `windtunnel view --json` prints: where the local API listens and its session token.
nonisolated struct BridgeInfo: Decodable, Sendable {
  let url: String
  let port: Int
  let token: String
  let pid: Int
  let root: String
  /// A viewer for this project was already running (another terminal, or an earlier app run): we use it, we don't own it.
  let reused: Bool
}

enum BridgeError: Error, LocalizedError {
  case exited(String)
  case timeout
  case http(Int, String)

  var errorDescription: String? {
    switch self {
    case .exited(let s): s
    case .timeout: "The Wind Tunnel bridge didn't answer within a minute."
    case .http(let code, let s): code == 401 ? "The bridge refused the session (\(s)). Reconnect." : s
    }
  }
}

/// The local bridge: a `windtunnel view --json` child process, the viewer's local API without its web page.
/// It exits when the app's end of its stdin closes, so it never outlives the app.
final class BridgeProcess {
  private var process: Process?
  private var input: Pipe?
  private(set) var stderrTail: [String] = []

  var isRunning: Bool { process?.isRunning ?? false }

  func start(project: String, toolchain: Toolchain.Resolved, anthropicKey: String?) async throws -> BridgeInfo {
    stop()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: toolchain.command[0])
    process.arguments = Array(toolchain.command.dropFirst()) + ["view", "--json", "--cwd", project]
    var env = toolchain.env
    // Headless Claude hunts are billed to this key, never to a Claude login (they run with --bare).
    if let anthropicKey, !anthropicKey.isEmpty { env["ANTHROPIC_API_KEY"] = anthropicKey } else { env.removeValue(forKey: "ANTHROPIC_API_KEY") }
    process.environment = env
    process.currentDirectoryURL = URL(fileURLWithPath: project)
    let input = Pipe()
    let output = Pipe()
    let errors = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = errors
    self.input = input
    self.process = process
    stderrTail = []

    errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      let lines = text.split(separator: "\n").map(String.init)
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.stderrTail = Array((self.stderrTail + lines).suffix(40))
      }
    }

    try process.run()
    let reader = output.fileHandleForReading
    let line: String? = try await withThrowingTaskGroup(of: String?.self) { group in
      group.addTask {
        for try await line in reader.bytes.lines { return line }
        return nil
      }
      group.addTask {
        try await Task.sleep(for: .seconds(60))
        throw BridgeError.timeout
      }
      let first = try await group.next() ?? nil
      group.cancelAll()
      return first
    }
    guard let line, let data = line.data(using: .utf8), let info = try? JSONDecoder().decode(BridgeInfo.self, from: data) else {
      try? await Task.sleep(for: .milliseconds(300))
      let why = stderrTail.suffix(6).joined(separator: "\n")
      throw BridgeError.exited(why.isEmpty ? "The bridge stopped before it started (\(toolchain.describe))." : why)
    }
    return info
  }

  func stop() {
    // Closing stdin asks the bridge to shut down cleanly (it stops its runs and hunts first).
    try? input?.fileHandleForWriting.close()
    if let process, process.isRunning {
      let p = process
      DispatchQueue.global().asyncAfter(deadline: .now() + 8) { if p.isRunning { p.terminate() } }
    }
    process = nil
    input = nil
  }
}

/// The local API. Every call carries the session token; the bridge only answers on 127.0.0.1.
nonisolated struct API: Sendable {
  let base: URL
  let token: String

  init(info: BridgeInfo) {
    base = URL(string: info.url)!
    token = info.token
  }

  private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
    var request = URLRequest(url: URL(string: path, relativeTo: base)!)
    request.httpMethod = method
    request.setValue(token, forHTTPHeaderField: "x-windtunnel-token")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "content-type")
    }
    return request
  }

  func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
    try await send(request(path))
  }

  func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
    try await send(request(path, method: "POST", body: try JSONSerialization.data(withJSONObject: body)))
  }

  func data(_ path: String) async throws -> Data {
    let (data, response) = try await URLSession.shared.data(for: request(path))
    try check(response, data)
    return data
  }

  private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
    let (data, response) = try await URLSession.shared.data(for: request)
    try check(response, data)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func check(_ response: URLResponse, _ data: Data) throws {
    guard let http = response as? HTTPURLResponse else { return }
    guard (200..<300).contains(http.statusCode) else {
      struct Failure: Decodable { let error: String }
      let message = (try? JSONDecoder().decode(Failure.self, from: data))?.error ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
      throw BridgeError.http(http.statusCode, message)
    }
  }

  /// `/api/events`: the store changing (runs, usage) and hunts and runs started from here, as they happen.
  func events() -> AsyncThrowingStream<ServerEvent, Error> {
    var stream = request("/api/events")
    stream.timeoutInterval = 3600
    let request = stream
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let (bytes, response) = try await URLSession.shared.bytes(for: request)
          if let http = response as? HTTPURLResponse, http.statusCode != 200 { throw BridgeError.http(http.statusCode, "event stream refused") }
          continuation.yield(.other)
          for try await line in bytes.lines where line.hasPrefix("data: ") {
            continuation.yield(ServerEvent.parse(Data(line.dropFirst(6).utf8)))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}

import AppKit
import Foundation
import Observation

/// First run: what the Mac has (from `windtunnel install --dry-run --json`), which app to open, and
/// whether its agent has set it up yet. Nothing is changed without a click, and the steps the CLI
/// would take are shown before Set Up runs them.
@Observable
final class Setup {
  enum Step: String, CaseIterable {
    /// Which app: a folder chosen or dropped.
    case app
    /// What its code shows, and what to do next: set it up with an agent, or open it.
    case read
  }

  var step: Step = .app
  /// The Mac's checks, in a sheet.
  var showMac = false

  // Your Mac.
  var toolchain: Toolchain.Resolved?
  /// No Node 22.18+, or no CLI: the CLI's own checks can't run.
  var toolchainProblem: Toolchain.Problem?
  var report: InstallReport?
  var checking = false
  var checkError: String?
  var installing = false
  var installOutput: [String] = []
  var installFailed = false

  // Your app.
  var folder: AppFolder?
  /// `windtunnel scan` of the folder: its handlers and what in them could go wrong.
  var scan: ScanReport?
  var scanning = false
  var scanError: String?
  /// The chosen folder holds no config yet; polled until the agent writes one.
  var watching = false

  private var watchTask: Task<Void, Never>?

  // MARK: Your Mac

  func check() {
    guard !checking else { return }
    checking = true
    checkError = nil
    Task {
      defer { checking = false }
      do {
        let resolved = try await Task.detached { try Toolchain.resolve(cliOverride: UserDefaults.standard.string(forKey: "cliPath")) }.value
        toolchain = resolved
        toolchainProblem = nil
        let data = try await Self.capture(resolved, ["install", "--dry-run", "--json"])
        report = try JSONDecoder().decode(InstallReport.self, from: data)
      } catch let problem as Toolchain.Problem {
        toolchain = nil
        toolchainProblem = problem
        report = nil
      } catch {
        checkError = error.localizedDescription
      }
    }
  }

  /// `windtunnel install --yes`: the steps listed, with the CLI's output as it goes. Checks again after.
  func install() {
    guard let toolchain, !installing else { return }
    installing = true
    installFailed = false
    installOutput = []
    Task {
      let code = await Self.stream(toolchain, ["install", "--yes"]) { line in
        // Download progress redraws one line: keep its newest state.
        if line.contains("%"), installOutput.last?.contains("%") == true { installOutput[installOutput.count - 1] = line } else { installOutput.append(line) }
      }
      installing = false
      installFailed = code != 0
      check()
    }
  }

  /// The steps as shell commands, for doing them by hand.
  var commands: String {
    (report?.steps ?? []).flatMap(\.detail).filter { !$0.contains("→") }.joined(separator: "\n")
  }

  // MARK: Your app

  func choose(_ path: String) {
    let next = AppFolder.inspect(path)
    if next.app != folder?.app { scan = nil }
    folder = next
    read()
    watch()
  }

  /// Reads the app's code with `windtunnel scan`: no config, build, database or model.
  func read() {
    guard let folder, folder.next != nil, !scanning else { return }
    scanning = true
    scanError = nil
    let path = folder.app
    Task {
      defer { scanning = false }
      do {
        var resolved = toolchain
        if resolved == nil {
          resolved = try await Task.detached { try Toolchain.resolve(cliOverride: UserDefaults.standard.string(forKey: "cliPath")) }.value
          toolchain = resolved
        }
        guard let resolved else { return }
        let data = try await Self.capture(resolved, ["scan", "--json", "--cwd", path])
        guard path == self.folder?.app else { return }
        scan = try JSONDecoder().decode(ScanReport.self, from: data)
      } catch let problem as Toolchain.Problem {
        toolchainProblem = problem
        scanError = problem.localizedDescription
      } catch {
        scanError = "Couldn't read the code: \(error.localizedDescription)"
      }
    }
  }

  /// While the chosen folder has no config, look for one every second and a half: the agent
  /// writes it in its own terminal.
  func watch() {
    watchTask?.cancel()
    guard let folder, folder.config == nil else {
      watching = false
      return
    }
    watching = true
    let path = folder.chosen
    watchTask = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1.5))
        let next = await Task.detached { AppFolder.inspect(path) }.value
        guard !Task.isCancelled else { return }
        if next != self.folder { self.folder = next }
        if next.config != nil {
          watching = false
          return
        }
      }
    }
  }

  func stopWatching() {
    watchTask?.cancel()
    watching = false
  }

  // MARK: Running the CLI

  nonisolated private static func process(_ toolchain: Toolchain.Resolved, _ args: [String]) -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: toolchain.command[0])
    process.arguments = Array(toolchain.command.dropFirst()) + args
    process.environment = toolchain.env
    process.standardInput = FileHandle.nullDevice
    return process
  }

  /// Runs the CLI and returns what it printed.
  nonisolated private static func capture(_ toolchain: Toolchain.Resolved, _ args: [String]) async throws -> Data {
    try await Task.detached {
      let process = Self.process(toolchain, args)
      let out = Pipe()
      process.standardOutput = out
      process.standardError = FileHandle.nullDevice
      try process.run()
      let data = out.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      return data
    }.value
  }

  /// Runs the CLI, handing each line of its output (both streams) to `line`; a progress line
  /// replaces the one before it. Returns the exit code.
  private static func stream(_ toolchain: Toolchain.Resolved, _ args: [String], line: (String) -> Void) async -> Int32 {
    let process = process(toolchain, args)
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = pipe
    let exit = AsyncStream<Int32> { continuation in
      process.terminationHandler = { continuation.yield($0.terminationStatus); continuation.finish() }
    }
    do {
      try process.run()
    } catch {
      line(error.localizedDescription)
      return 127
    }
    do {
      for try await text in pipe.fileHandleForReading.bytes.lines where !text.trimmingCharacters(in: .whitespaces).isEmpty {
        line(text)
      }
    } catch {}
    for await code in exit { return code }
    return process.terminationStatus
  }
}

/// `windtunnel scan --json`.
nonisolated struct ScanReport: Decodable, Sendable, Equatable {
  struct Risk: Decodable, Sendable, Equatable {
    let flag: String
    let says: String
  }

  struct Route: Decodable, Sendable, Equatable, Identifiable {
    let method: String
    let path: String
    let file: String
    let comment: String?
    let does: String
    let risks: [Risk]
    let guards: [String]

    var id: String { method + " " + path + " " + file }
  }

  let root: String
  let framework: String
  let routes: [Route]
  let pages: Int
  let helpers: [Risk]
}

/// `windtunnel install --dry-run --json`.
nonisolated struct InstallReport: Decodable, Sendable, Equatable {
  struct Check: Decodable, Sendable, Equatable {
    let name: String
    let ok: Bool
    let detail: String
  }

  struct Agent: Decodable, Sendable, Equatable {
    let host: String
    let name: String
    let found: Bool
    let plugin: Bool
  }

  struct Step: Decodable, Sendable, Equatable {
    let title: String
    let detail: [String]
  }

  let checks: [Check]
  let agents: [Agent]
  let steps: [Step]
  let notes: [String]
  let blocked: Bool

  func check(_ name: String) -> Check? { checks.first { $0.name == name } }
}

/// What a folder holds, read from disk: where its config is (here, above or a little below), and
/// enough about the app to say whether Wind Tunnel can run it.
nonisolated struct AppFolder: Equatable, Sendable {
  /// The folder picked.
  let chosen: String
  /// windtunnel.config.yaml, if there is one.
  let config: String?
  /// More than one below the chosen folder: which app is meant.
  let configs: [String]
  /// The app's folder: the config's, else the chosen one (or the one Next.js is in below it).
  let app: String
  let git: Bool
  let next: String?
  let database: String?
  let packageManager: String?
  let experiments: Int
  let flows: Int

  var name: String { (app as NSString).lastPathComponent }
  var supported: Bool { git && next != nil }

  static let configName = "windtunnel.config.yaml"

  static func inspect(_ path: String) -> AppFolder {
    let fm = FileManager.default
    let chosen = (path as NSString).standardizingPath
    var config: String?
    var dir = chosen
    while true {
      let candidate = (dir as NSString).appendingPathComponent(configName)
      if fm.fileExists(atPath: candidate) {
        config = candidate
        break
      }
      let parent = (dir as NSString).deletingLastPathComponent
      if parent == dir || parent.isEmpty { break }
      dir = parent
    }
    var below: [String] = []
    if config == nil { below = find(configName, under: chosen, depth: 3) }
    if below.count == 1 { config = below[0] }

    var app = config.map { ($0 as NSString).deletingLastPathComponent } ?? chosen
    var pkg = packageJSON(app)
    if config == nil, pkg?.next == nil, let nested = find("package.json", under: chosen, depth: 2)
      .map({ ($0 as NSString).deletingLastPathComponent })
      .first(where: { packageJSON($0)?.next != nil })
    {
      app = nested
      pkg = packageJSON(nested)
    }

    let state = (app as NSString).appendingPathComponent(".windtunnel")
    let experiments = (try? fm.contentsOfDirectory(atPath: (state as NSString).appendingPathComponent("experiments")))?
      .filter { $0.hasSuffix(".yaml") || $0.hasSuffix(".yml") }.count ?? 0
    let flows = (try? fm.contentsOfDirectory(atPath: (state as NSString).appendingPathComponent("flows")))?
      .filter { $0.hasSuffix(".ts") }.count ?? 0

    return AppFolder(
      chosen: chosen, config: config, configs: below.count > 1 ? below : [], app: app, git: insideGit(app),
      next: pkg?.next, database: pkg?.database ?? prismaPostgres(app), packageManager: lockfile(app),
      experiments: experiments, flows: flows)
  }

  private static func find(_ name: String, under root: String, depth: Int) -> [String] {
    var found: [String] = []
    func walk(_ dir: String, _ level: Int) {
      guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
      for entry in entries.sorted() {
        let path = (dir as NSString).appendingPathComponent(entry)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDir) else { continue }
        if isDir.boolValue {
          if level < depth, !entry.hasPrefix("."), entry != "node_modules" { walk(path, level + 1) }
        } else if entry == name, level > 0 {
          found.append(path)
        }
      }
    }
    walk(root, 0)
    return found
  }

  private static func packageJSON(_ dir: String) -> (next: String?, database: String?)? {
    guard let data = FileManager.default.contents(atPath: (dir as NSString).appendingPathComponent("package.json")),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    var deps: [String: String] = [:]
    for key in ["dependencies", "devDependencies"] {
      for (k, v) in json[key] as? [String: Any] ?? [:] { deps[k] = v as? String ?? "" }
    }
    let next = deps["next"].map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "^~>=< ")) }
    let drivers: [(String, String)] = [
      ("pg", "Postgres (pg)"), ("postgres", "Postgres (postgres.js)"), ("@neondatabase/serverless", "Postgres (Neon driver)"),
      ("@vercel/postgres", "Postgres (Vercel)"), ("@prisma/client", "Prisma"), ("drizzle-orm", "Drizzle"), ("kysely", "Kysely"),
    ]
    let database = drivers.first { deps[$0.0] != nil }?.1
    return (next, database)
  }

  private static func prismaPostgres(_ dir: String) -> String? {
    let schema = (dir as NSString).appendingPathComponent("prisma/schema.prisma")
    guard let text = try? String(contentsOfFile: schema, encoding: .utf8) else { return nil }
    return text.contains("\"postgresql\"") ? "Postgres (Prisma)" : nil
  }

  private static func insideGit(_ dir: String) -> Bool {
    var d = dir
    while true {
      if FileManager.default.fileExists(atPath: (d as NSString).appendingPathComponent(".git")) { return true }
      let parent = (d as NSString).deletingLastPathComponent
      if parent == d || parent.isEmpty { return false }
      d = parent
    }
  }

  /// The lockfile in the app's folder or above it, up to the top of its repository.
  private static func lockfile(_ dir: String) -> String? {
    let locks = [("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "Yarn"), ("bun.lock", "Bun"), ("bun.lockb", "Bun"), ("package-lock.json", "npm")]
    var d = dir
    while true {
      if let hit = locks.first(where: { FileManager.default.fileExists(atPath: (d as NSString).appendingPathComponent($0.0)) }) { return hit.1 }
      let parent = (d as NSString).deletingLastPathComponent
      if FileManager.default.fileExists(atPath: (d as NSString).appendingPathComponent(".git")) || parent == d || parent.isEmpty { return nil }
      d = parent
    }
  }
}

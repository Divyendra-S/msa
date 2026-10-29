import Foundation

/// Finds what the bridge needs on a Mac where apps started from the Finder don't get the
/// terminal's PATH: the login shell's environment, a Node new enough to run Wind Tunnel
/// (22.18+), and the `windtunnel` CLI (installed, or this repository's checkout).
nonisolated enum Toolchain {
  struct Resolved: Sendable {
    /// node and the CLI's entry file: `[node, bin.js]`.
    let command: [String]
    let env: [String: String]
    let describe: String

    /// The agent plugin next to the CLI: plugins/windtunnel in a checkout, plugin/ in the npm package.
    var pluginDir: String? {
      guard let entry = command.last else { return nil }
      let candidates = [
        ((entry as NSString).deletingLastPathComponent as NSString).appendingPathComponent("../plugin"),
        ((entry as NSString).deletingLastPathComponent as NSString).appendingPathComponent("../../../plugins/windtunnel"),
      ].map { ($0 as NSString).standardizingPath }
      return candidates.first { FileManager.default.fileExists(atPath: ($0 as NSString).appendingPathComponent("skills")) }
    }
  }

  enum Problem: Error, LocalizedError {
    case noNode(String)
    case noCLI(String)

    var errorDescription: String? {
      switch self {
      case .noNode(let s), .noCLI(let s): s
      }
    }
  }

  static let minimumNode = (22, 18)

  /// The CLI to use: the setting, else `windtunnel` on the login PATH, else the checkout the app was built from.
  static func resolve(cliOverride: String?) throws -> Resolved {
    var env = loginEnvironment()
    let path = env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
    guard let node = findNode(path: path) else {
      throw Problem.noNode("Wind Tunnel needs Node 22.18 or newer. Install it (nodejs.org, Homebrew or nvm), then reopen the project.")
    }
    // Child processes (the app's build, pnpm, the CLI's own runs) use the same Node.
    env["PATH"] = (node as NSString).deletingLastPathComponent + ":" + path
    env["WINDTUNNEL_FROM_APP"] = "1"

    if let o = cliOverride?.trimmingCharacters(in: .whitespaces), !o.isEmpty {
      return Resolved(command: [node, realPath(o)], env: env, describe: Fmt.tilde(o))
    }
    if let bin = which("windtunnel", path: path) {
      let real = realPath(bin)
      // A JavaScript entry runs on our Node; anything else (a shell wrapper) is run as is.
      let command = real.hasSuffix(".js") || real.hasSuffix(".ts") || real.hasSuffix(".mjs") ? [node, real] : [real]
      return Resolved(command: command, env: env, describe: Fmt.tilde(bin))
    }
    if let repo = Bundle.main.object(forInfoDictionaryKey: "WTRepoRoot") as? String ?? ProcessInfo.processInfo.environment["WINDTUNNEL_REPO"] {
      let src = (repo as NSString).appendingPathComponent("packages/cli/src/bin.ts")
      if FileManager.default.fileExists(atPath: src) {
        return Resolved(command: [node, src], env: env, describe: "checkout " + Fmt.tilde(repo))
      }
    }
    throw Problem.noCLI("The windtunnel CLI wasn't found. Install it with `npx windtunnel-cli install`, or set its path in Settings.")
  }

  /// The environment of an interactive login shell (nvm and Homebrew set PATH there).
  static func loginEnvironment() -> [String: String] {
    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let marker = "__WINDTUNNEL_ENV__"
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-ilc", "printf '\(marker)'; /usr/bin/env -0"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    var env = ProcessInfo.processInfo.environment
    do {
      try process.run()
      // A slow or stuck shell profile must not hang the app.
      let deadline = Date().addingTimeInterval(6)
      while process.isRunning && Date() < deadline { usleep(20_000) }
      if process.isRunning { process.terminate() }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      if let text = String(data: data, encoding: .utf8), let range = text.range(of: marker) {
        for entry in text[range.upperBound...].split(separator: "\0") {
          guard let eq = entry.firstIndex(of: "=") else { continue }
          env[String(entry[..<eq])] = String(entry[entry.index(after: eq)...])
        }
      }
    } catch {}
    return env
  }

  /// The newest Node ≥ 22.18 on PATH, in nvm's folder, or in Homebrew's.
  static func findNode(path: String) -> String? {
    var candidates: [String] = path.split(separator: ":").map { "\($0)/node" }
    let nvm = (NSHomeDirectory() as NSString).appendingPathComponent(".nvm/versions/node")
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
      candidates += versions.map { "\(nvm)/\($0)/bin/node" }
    }
    candidates += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    var best: (String, [Int])?
    var seen = Set<String>()
    for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
      let real = realPath(c)
      guard seen.insert(real).inserted, let v = nodeVersion(c) else { continue }
      guard v[0] > minimumNode.0 || (v[0] == minimumNode.0 && v[1] >= minimumNode.1) else { continue }
      if best == nil || best!.1.lexicographicallyPrecedes(v) { best = (c, v) }
    }
    return best?.0
  }

  private static func nodeVersion(_ node: String) -> [Int]? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = ["--version"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    process.waitUntilExit()
    let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").compactMap { Int($0) }
    return parts.count >= 2 ? parts : nil
  }

  static func which(_ name: String, path: String) -> String? {
    path.split(separator: ":").map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  static func realPath(_ path: String) -> String {
    (path as NSString).resolvingSymlinksInPath
  }
}

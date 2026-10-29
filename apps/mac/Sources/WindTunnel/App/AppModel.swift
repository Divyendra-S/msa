import AppKit
import Foundation
import Observation
import UserNotifications

enum Pane: String, CaseIterable, Identifiable {
  case overview, runs, experiments, hunt, usage
  var id: String { rawValue }

  var title: String {
    switch self {
    case .overview: "Overview"
    case .runs: "Runs"
    case .experiments: "Experiments"
    case .hunt: "Hunt"
    case .usage: "Usage"
    }
  }

  var symbol: String {
    switch self {
    case .overview: "square.grid.2x2"
    case .runs: "list.bullet.rectangle"
    case .experiments: "flask"
    case .hunt: "scope"
    case .usage: "gauge.with.dots.needle.33percent"
    }
  }
}

/// Something that happened in the project, newest first: what a hunt (here or in your own
/// Claude Code session) is doing, seen through the runs it starts and finishes.
struct Activity: Identifiable, Hashable {
  let id = UUID()
  let at: Date
  let kind: Kind
  let text: String
  var run: String? = nil
  var outcome: String? = nil

  enum Kind: Hashable { case started, finished, job, hunt, note }
}

/// Everything the window shows, kept current by the bridge's event stream.
@Observable
final class AppModel {
  static let shared = AppModel()

  enum Phase: Equatable {
    case welcome
    case connecting(String)
    case connected
    case failed(String)
  }

  var phase: Phase = .welcome
  var projectPath: String?
  var recents: [String] = UserDefaults.standard.stringArray(forKey: "recentProjects") ?? []
  var toolchainDescription = ""
  var pluginDir: String?

  var info: BridgeInfo?
  var api: API?
  var status: Status?
  var runs: [RunListEntry] = []
  var experiments: [ExperimentEntry] = []
  var experimentsError: String?
  var usage: Usage?
  var hunts: [HuntInfo] = []
  var jobs: [RunJob] = []
  var live = false

  var section: Pane = .overview
  var selectedRun: String?
  var selectedExperiment: String?
  var selectedHunt: String?
  /// Bumped per run when the store says it changed, so an open run reloads.
  var runVersions: [String: Int] = [:]
  var huntEvents: [String: [HuntEvent]] = [:]
  var activity: [Activity] = []
  var notice: String?

  var hasAnthropicKey = Keychain.read() != nil
  var cliPath: String = UserDefaults.standard.string(forKey: "cliPath") ?? "" {
    didSet { UserDefaults.standard.set(cliPath, forKey: "cliPath") }
  }

  private let bridge = BridgeProcess()
  private var streamTask: Task<Void, Never>?
  private var connectTask: Task<Void, Never>?

  // MARK: Connecting

  func start() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--pane"), args.count > i + 1, let pane = Pane(rawValue: args[i + 1]) { section = pane }
    if args.contains("--welcome") { return }
    // A project named on the command line opens at once; otherwise the start page, with the recent ones.
    if let i = args.firstIndex(of: "--project"), args.count > i + 1 {
      open(project: args[i + 1])
    } else if let env = ProcessInfo.processInfo.environment["WINDTUNNEL_PROJECT"] {
      open(project: env)
    }
    // After opening, which clears the selection.
    if let i = args.firstIndex(of: "--run"), args.count > i + 1 { selectedRun = args[i + 1] }
  }

  /// Back to the start page: the bridge stops (if it's ours).
  func closeProject() {
    connectTask?.cancel()
    disconnect()
    projectPath = nil
    phase = .welcome
  }

  func chooseProject() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Open"
    panel.message = "Choose an app's folder: the one with windtunnel.config.yaml (or one above or below it)."
    if panel.runModal() == .OK, let url = panel.url { open(project: url.path) }
  }

  func open(project: String) {
    connectTask?.cancel()
    disconnect()
    let path = (project as NSString).standardizingPath
    projectPath = path
    phase = .connecting(path)
    let override = cliPath
    connectTask = Task {
      do {
        let toolchain = try await Task.detached { try Toolchain.resolve(cliOverride: override) }.value
        toolchainDescription = toolchain.describe
        pluginDir = toolchain.pluginDir
        let info = try await bridge.start(project: path, toolchain: toolchain, anthropicKey: Keychain.read())
        try Task.checkCancellation()
        self.info = info
        self.api = API(info: info)
        remember(info.root)
        try await refreshAll()
        phase = .connected
        listen()
        requestNotifications()
      } catch is CancellationError {
      } catch {
        phase = .failed(error.localizedDescription)
      }
    }
  }

  func reconnect() {
    if let projectPath { open(project: projectPath) }
  }

  func disconnect() {
    streamTask?.cancel()
    streamTask = nil
    bridge.stop()
    api = nil
    info = nil
    live = false
    status = nil
    runs = []
    experiments = []
    usage = nil
    hunts = []
    jobs = []
    activity = []
    huntEvents = [:]
    runVersions = [:]
    selectedRun = nil
    selectedExperiment = nil
    selectedHunt = nil
  }

  func shutdown() {
    streamTask?.cancel()
    bridge.stop()
  }

  private func remember(_ root: String) {
    recents = [root] + recents.filter { $0 != root }
    recents = Array(recents.prefix(8))
    UserDefaults.standard.set(recents, forKey: "recentProjects")
  }

  func forget(_ path: String) {
    recents.removeAll { $0 == path }
    UserDefaults.standard.set(recents, forKey: "recentProjects")
  }

  // MARK: Loading

  func refreshAll() async throws {
    guard let api else { return }
    async let s: Status = api.get("/api/status")
    async let r: [RunListEntry] = api.get("/api/runs?limit=300")
    async let u: Usage = api.get("/api/usage")
    async let h: [HuntInfo] = api.get("/api/hunts")
    async let j: [RunJob] = api.get("/api/jobs")
    status = try await s
    runs = try await r
    usage = try? await u
    hunts = (try? await h) ?? []
    jobs = (try? await j) ?? []
    await loadExperiments()
  }

  func loadStatus() async {
    if let s: Status = try? await api?.get("/api/status") { status = s }
  }

  func loadRuns() async {
    if let r: [RunListEntry] = try? await api?.get("/api/runs?limit=300") { runs = r }
  }

  func loadUsage() async {
    if let u: Usage = try? await api?.get("/api/usage") { usage = u }
  }

  func loadExperiments() async {
    guard let api else { return }
    do {
      experiments = try await api.get("/api/experiments")
      experimentsError = nil
    } catch {
      experimentsError = error.localizedDescription
    }
  }

  func loadHunts() async {
    if let h: [HuntInfo] = try? await api?.get("/api/hunts") { hunts = h }
  }

  private func listen() {
    streamTask?.cancel()
    streamTask = Task {
      var delay = 1.0
      while !Task.isCancelled, let api {
        do {
          for try await event in api.events() {
            if !live {
              live = true
              delay = 1
              // Catch up on what changed while the stream was down.
              await loadRuns()
              await loadUsage()
            }
            await handle(event)
          }
        } catch {}
        live = false
        if Task.isCancelled { break }
        // The bridge went away: bring it back if it was ours.
        if !bridge.isRunning, info?.reused == false {
          phase = .failed("The bridge stopped. " + bridge.stderrTail.suffix(3).joined(separator: " "))
          return
        }
        try? await Task.sleep(for: .seconds(delay))
        delay = min(10, delay * 2)
      }
    }
  }

  private func handle(_ event: ServerEvent) async {
    switch event {
    case .runs(let changed):
      let before = Dictionary(uniqueKeysWithValues: runs.map { ($0.id, $0) })
      await loadRuns()
      for id in changed {
        runVersions[id, default: 0] += 1
        guard let now = runs.first(where: { $0.id == id }) else { continue }
        let old = before[id]
        if old == nil {
          note(Activity(at: .now, kind: now.outcome == "running" ? .started : .finished, text: now.experiment, run: id, outcome: now.outcome))
        } else if old?.outcome == "running" && now.outcome != "running" {
          note(Activity(at: .now, kind: .finished, text: now.experiment, run: id, outcome: now.outcome))
        }
      }
      if changed.contains(where: { id in runs.first { $0.id == id }?.outcome != "running" }) { await loadExperiments() }
    case .usage:
      await loadUsage()
    case .hunt(let id, let info):
      if let i = hunts.firstIndex(where: { $0.id == id }) { hunts[i] = info } else { hunts.insert(info, at: 0) }
      await loadStatus()
      if info.status == "running" {
        note(Activity(at: .now, kind: .hunt, text: "hunt started: \(info.prompt)"))
      } else {
        note(Activity(at: .now, kind: .hunt, text: "hunt \(info.status): \(info.prompt)", outcome: info.status))
        notify(title: "Hunt \(info.status)", body: "\(info.prompt) · \(Fmt.usd(info.usage.usd))")
      }
    case .huntEvent(let id, let event):
      huntEvents[id, default: []].append(event)
    case .job(let id, let info):
      if let i = jobs.firstIndex(where: { $0.id == id }) { jobs[i] = info } else { jobs.insert(info, at: 0) }
      await loadStatus()
      if info.status != "running" {
        note(Activity(at: .now, kind: .job, text: "run \(info.status): \(info.experiments.isEmpty ? "all experiments" : info.experiments.joined(separator: ", "))", outcome: info.status))
        let failing = runs.prefix(40).filter { $0.outcome == "fail" && ($0.started > (ISO.date(info.startedAt) ?? .now)) }.count
        notify(title: failing > 0 ? "\(failing) experiment\(failing == 1 ? "" : "s") failing" : "Run finished", body: info.error ?? (info.experiments.isEmpty ? "All experiments" : info.experiments.joined(separator: ", ")))
      }
    case .jobOutput(let id, let line):
      if let i = jobs.firstIndex(where: { $0.id == id }) {
        let j = jobs[i]
        jobs[i] = RunJob(id: j.id, experiments: j.experiments, repeatCount: j.repeatCount, startedAt: j.startedAt, endedAt: j.endedAt, status: j.status, exitCode: j.exitCode, error: j.error, output: Array((j.output + [line]).suffix(200)))
      }
    case .other:
      break
    }
  }

  private func note(_ a: Activity) {
    activity.insert(a, at: 0)
    if activity.count > 200 { activity.removeLast(activity.count - 200) }
  }

  // MARK: Actions

  var runningJob: RunJob? { jobs.first { $0.status == "running" } ?? status?.jobs?.running }
  var runningHunt: HuntInfo? { hunts.first { $0.status == "running" } ?? status?.hunt.running }

  func runExperiments(_ ids: [String], repeat count: Int? = nil) {
    guard let api else { return }
    Task {
      do {
        var body: [String: Any] = ["experiments": ids]
        if let count { body["repeat"] = count }
        let job: RunJob = try await api.post("/api/experiments/run", body)
        if !jobs.contains(where: { $0.id == job.id }) { jobs.insert(job, at: 0) }
        note(Activity(at: .now, kind: .job, text: "run started: \(ids.isEmpty ? "all experiments" : ids.joined(separator: ", "))"))
      } catch {
        notice = error.localizedDescription
      }
    }
  }

  func stopJob(_ id: String) {
    guard let api else { return }
    Task { let _: [String: Bool]? = try? await api.post("/api/jobs/\(id)/stop") }
  }

  func startHunt(prompt: String, host: String, model: String?, budget: Double?) {
    guard let api else { return }
    Task {
      do {
        var body: [String: Any] = ["prompt": prompt, "host": host]
        if let model { body["model"] = model }
        if let budget { body["budgetUsd"] = budget }
        let info: HuntInfo = try await api.post("/api/hunts", body)
        if !hunts.contains(where: { $0.id == info.id }) { hunts.insert(info, at: 0) }
        selectedHunt = info.id
        await loadStatus()
      } catch {
        notice = error.localizedDescription
      }
    }
  }

  func stopHunt(_ id: String) {
    guard let api else { return }
    Task { let _: [String: Bool]? = try? await api.post("/api/hunts/\(id)/stop") }
  }

  func loadHunt(_ id: String) async {
    guard let api, huntEvents[id] == nil || hunts.first(where: { $0.id == id })?.status != "running" else { return }
    if let detail: HuntDetail = try? await api.get("/api/hunts/\(id)") { huntEvents[id] = detail.events }
  }

  /// Opens Claude Code in a new terminal in the app's folder with the prompt typed but not sent:
  /// it runs on your own login only when you press Enter, in your own Claude Code.
  func openInClaudeCode(_ prompt: String) {
    guard let root = status?.project.root ?? projectPath else { return }
    var c = URLComponents()
    c.scheme = "claude-cli"
    c.host = "open"
    c.queryItems = [URLQueryItem(name: "cwd", value: root), URLQueryItem(name: "q", value: String(prompt.prefix(4990)))]
    if let url = c.url, NSWorkspace.shared.urlForApplication(toOpen: url) != nil {
      NSWorkspace.shared.open(url)
      return
    }
    // No handler for the link: a Terminal window with `claude`, and the prompt on the clipboard.
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(prompt, forType: .string)
    let plugin = pluginDir.map { " --plugin-dir '\($0)'" } ?? ""
    let script = "#!/bin/zsh -il\ncd '\(root)' && exec claude\(plugin)\n"
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("windtunnel-claude-\(UUID().uuidString.prefix(8)).command")
    do {
      try script.write(to: file, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
      NSWorkspace.shared.open(file)
      notice = "Opened Claude Code in Terminal. The prompt is on the clipboard: paste it and press Enter."
    } catch {
      notice = error.localizedDescription
    }
  }

  func saveAnthropicKey(_ key: String?) {
    if let key, !key.trimmingCharacters(in: .whitespaces).isEmpty {
      Keychain.save(key.trimmingCharacters(in: .whitespacesAndNewlines))
    } else {
      Keychain.delete()
    }
    hasAnthropicKey = Keychain.read() != nil
    // The key reaches the bridge through its environment: restart it (only if it's ours).
    if info?.reused == false { reconnect() }
  }

  func reveal(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  func openFile(_ path: String) {
    NSWorkspace.shared.open(URL(fileURLWithPath: path))
  }

  // MARK: Notifications

  private func requestNotifications() {
    guard Bundle.main.bundleIdentifier != nil else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  private func notify(title: String, body: String) {
    guard Bundle.main.bundleIdentifier != nil, !NSApp.isActive else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }

  // MARK: Derived

  /// Runs started together (one `windtunnel run`): within two seconds of each other, newest first.
  var batches: [Batch] { Batch.group(runs) }

  /// Each experiment's newest finished run.
  var latestByExperiment: [String: RunListEntry] {
    var out: [String: RunListEntry] = [:]
    for r in runs where r.outcome != "running" && out[r.experiment] == nil { out[r.experiment] = r }
    return out
  }

  /// Each experiment's runs, newest first.
  var runsByExperiment: [String: [RunListEntry]] { Dictionary(grouping: runs, by: \.experiment) }

  func run(_ id: String) -> RunListEntry? { runs.first { $0.id == id } }

  /// How a run's experiment had been doing up to it: whether this failure is new.
  func streak(of run: RunListEntry) -> Streak? {
    guard let all = runsByExperiment[run.experiment], let i = all.firstIndex(of: run) else { return nil }
    return Streak(Array(all[i...]))
  }
}

/// A failing run's place in its experiment's history: the first failure after runs that held,
/// one of several in a row, or an experiment that has never held.
enum Streak: Equatable {
  case new
  case row(Int)
  case never

  /// From runs newest first, the newest being the one asked about.
  init?(_ runs: [RunListEntry]) {
    let finished = runs.filter { $0.outcome != "running" }
    guard let first = finished.first, first.outcome != "pass" else { return nil }
    let n = finished.prefix { $0.outcome != "pass" }.count
    if n == finished.count { self = .never }
    else if n == 1 { self = .new }
    else { self = .row(n) }
  }

  var text: String {
    switch self {
    case .new: "new"
    case .row(let n): "\(n) in a row"
    case .never: "never held"
    }
  }

  var help: String {
    switch self {
    case .new: "The run before this one held: this broke just now."
    case .row(let n): "Failed the last \(n) times it ran."
    case .never: "It has failed every time it ran."
    }
  }
}

struct Batch: Identifiable, Hashable {
  let id: String
  let started: Date
  var runs: [RunListEntry]

  static func group(_ runs: [RunListEntry]) -> [Batch] {
    var out: [Batch] = []
    for r in runs {
      if var last = out.last, abs(last.started.timeIntervalSince(r.started)) < 2 {
        last.runs.append(r)
        out[out.count - 1] = last
      } else {
        out.append(Batch(id: r.id, started: r.started, runs: [r]))
      }
    }
    return out
  }

  func count(_ outcome: String) -> Int { runs.filter { $0.outcome == outcome }.count }
}

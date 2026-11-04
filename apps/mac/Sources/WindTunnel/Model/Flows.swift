import SwiftUI

/// One of the app's user flows (a flow file, or a Swift app's scenario) with the experiments that
/// drive it, as the Overview lays them out: a row per flow, a card per experiment.
struct FlowGroup: Identifiable {
  let id: String
  var experiments: [Replay.Experiment]

  var title: String { Self.title(id) }

  /// Some experiment on it didn't hold on its newest run.
  var breaks: Bool { experiments.contains { TestVerdict($0).failing } }

  /// The run its steps are shown from: the one that leaves the flow as it is, else any that ran.
  var reference: Replay.Experiment? {
    experiments.first { $0.pressure.isEmpty && $0.run != nil } ?? experiments.first { $0.run != nil }
  }

  /// Flows with something broken first, then by name; in each, the one left as it is first.
  static func group(_ experiments: [Replay.Experiment]) -> [FlowGroup] {
    var order: [String] = []
    var by: [String: [Replay.Experiment]] = [:]
    for e in experiments {
      if by[e.flowKey] == nil { order.append(e.flowKey) }
      by[e.flowKey, default: []].append(e)
    }
    return order
      .map { key in
        FlowGroup(id: key, experiments: by[key]!.sorted { a, b in
          a.pressure.isEmpty != b.pressure.isEmpty ? a.pressure.isEmpty : a.id < b.id
        })
      }
      .sorted { a, b in a.breaks != b.breaks ? a.breaks : a.title < b.title }
  }

  /// `RecorderScenarios/testStopWhileWriting` → `Stop while writing`; `buy-now` → `Buy now`.
  static func title(_ key: String) -> String {
    var name = key.split(separator: "/").last.map(String.init) ?? key
    if name.hasPrefix("test"), name.count > 4, name.dropFirst(4).first?.isUppercase == true { name = String(name.dropFirst(4)) }
    var words: [String] = []
    var current = ""
    for ch in name {
      if ch == "-" || ch == "_" || ch == " " || ch == "." {
        if !current.isEmpty { words.append(current) }
        current = ""
        continue
      }
      if ch.isUppercase, let last = current.last, !last.isUppercase {
        words.append(current)
        current = ""
      }
      current.append(ch)
    }
    if !current.isEmpty { words.append(current) }
    // Acronyms stay as they are: `PDF`, `API`.
    let lower = words.map { $0.count > 1 && $0 == $0.uppercased() ? $0 : $0.lowercased() }
    guard let first = lower.first else { return key }
    return ([first.prefix(1).uppercased() + first.dropFirst()] + lower.dropFirst()).joined(separator: " ")
  }
}

extension Replay.Experiment {
  /// The flow it drives, or its scenario; itself when it has neither.
  var flowKey: String { flow ?? scenario ?? id }
}

/// How an experiment's newest run went, as a card says it: a word, a colour, and its runs.
struct TestVerdict {
  enum Kind { case holds, breaks, crashes, stops, running, notRun }

  let kind: Kind
  /// Runs that broke a rule or couldn't finish (or, running, finished), of `total`.
  let failed: Int
  let total: Int

  init(_ e: Replay.Experiment, running: RunListEntry? = nil) {
    if let progress = running?.running {
      kind = .running
      failed = progress.done
      total = progress.total
      return
    }
    guard let run = e.run else {
      kind = .notRun
      failed = 0
      total = 0
      return
    }
    total = run.reps
    failed = run.failed ?? (run.outcome == "pass" ? 0 : run.reps)
    let errors = run.errors ?? (run.outcome == "error" ? run.reps : 0)
    if run.outcome == "pass" {
      kind = .holds
    } else if errors > 0 && errors == failed {
      // Nothing broke a rule: the app went down, or the flow couldn't go on.
      kind = (run.error ?? "").range(of: "crash", options: .caseInsensitive) != nil ? .crashes : .stops
    } else {
      kind = .breaks
    }
  }

  var failing: Bool { kind == .breaks || kind == .crashes || kind == .stops }

  var word: String {
    switch kind {
    case .holds: "Holds"
    case .breaks: "Breaks"
    case .crashes: "Crashes"
    case .stops: "Can't finish"
    case .running: "Running"
    case .notRun: "Not run"
    }
  }

  /// Every run failing is red; some, amber.
  var color: Color {
    switch kind {
    case .holds: Theme.accent
    case .breaks, .crashes, .stops: failed >= total ? Theme.fail : Theme.flaky
    case .running: Theme.accent
    case .notRun: Theme.ghost
    }
  }

  /// `3 of 9`: the runs that failed, or held; while running, those done.
  var count: String {
    switch kind {
    case .holds: "\(total) of \(total)"
    case .breaks, .crashes, .stops: "\(failed) of \(total)"
    case .running: "\(failed) of \(total)"
    case .notRun: ""
    }
  }
}

/// What an experiment does to the app, in a few words and a symbol: `slowed 300 ms`, `2 at once`.
enum Pressure {
  static func words(_ p: [AppMap.Pressure]) -> String {
    p.isEmpty ? "As is" : p.map(\.what).joined(separator: " + ").capitalizedFirst
  }

  /// Where it lands: a probe point, a route.
  static func place(_ p: [AppMap.Pressure]) -> String? {
    p.first?.routes.first.map { $0.hasPrefix("POINT ") ? String($0.dropFirst(6)) : $0 }
  }

  static func symbol(_ p: [AppMap.Pressure]) -> String {
    guard let what = p.first?.what else { return "circle" }
    let table: [(String, String)] = [
      ("at once", "arrow.triangle.merge"),
      ("slowed", "tortoise"),
      ("threw", "exclamationmark.triangle"),
      ("answered", "exclamationmark.triangle"),
      ("cancelled", "xmark.circle"),
      ("lost", "wifi.slash"),
      ("offline", "wifi.slash"),
      ("twice", "square.on.square"),
      ("double", "square.on.square"),
      ("repeated", "square.on.square"),
      ("webhook", "arrow.down.left.circle"),
      ("killed", "power"),
      ("background", "moon"),
      ("refreshed", "arrow.clockwise"),
      ("back and", "arrow.uturn.backward"),
      ("second tab", "macwindow.on.rectangle"),
      ("session", "clock.badge.xmark"),
      ("clock", "clock.arrow.circlepath"),
      ("turned", "rotate.right"),
      ("push", "bell"),
      ("replayed", "person.2"),
    ]
    return table.first { what.contains($0.0) }?.1 ?? "bolt"
  }
}

extension String {
  var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }

  /// Up to the end of the first sentence.
  var firstSentence: String {
    for end in [". ", "! ", "? "] {
      if let r = range(of: end) { return String(self[..<r.lowerBound]) + String(end.first!) }
    }
    return self
  }
}

/// What went wrong, for a person: the cause the agent found, else the rule that broke, else the error.
enum FindingText {
  static func headline(_ e: Replay.Experiment) -> String {
    if let cause = e.finding?.cause { return cause.firstSentence }
    if let rule = e.rules.broken.first { return rule.description ?? "\(rule.id) broke" }
    if let error = e.run?.error { return error.split(separator: "\n").first.map(String.init) ?? error }
    return e.description ?? e.id
  }

  /// Whether the headline is the agent's cause (a statement of the bug) or only the rule it broke.
  static func explained(_ e: Replay.Experiment) -> Bool { e.finding != nil }

  /// The picture that shows it best: the step that failed, or the last one pictured before it (the
  /// step that failed then comes as `failed`); with no step failing, where the flow ended.
  static func evidence(_ e: Replay.Experiment) -> (frame: Replay.Frame?, failed: Replay.Frame?) {
    let main = e.frames.filter { $0.lane == 0 }.sorted { $0.column < $1.column }
    if let failed = e.frames.last(where: { $0.error != nil }) {
      if failed.shot != nil { return (failed, nil) }
      let before = main.last { $0.shot != nil && $0.column < failed.column }
      return (before ?? failed, before == nil ? nil : failed)
    }
    return (main.last { $0.shot != nil } ?? main.last ?? e.frames.last, nil)
  }
}

/// A prompt for a coding agent: what breaks, how to see it, why and where if known, and how to
/// prove the fix. Pasted into Claude Code or Codex by the person, never sent from here.
enum FixPrompt {
  static func text(_ e: Replay.Experiment, file: String?, project: String?) -> String {
    let verdict = TestVerdict(e)
    var lines: [String] = []
    let app = project.map { " in \($0)" } ?? ""
    lines.append(e.finding != nil ? "Fix this bug\(app), found by Wind Tunnel." : "Find out why this breaks\(app), and fix it. Wind Tunnel found it.")
    lines.append("")
    lines.append("What happens: \(e.description ?? e.id)")
    if !e.pressure.isEmpty {
      lines.append("What the test does to the app: \(e.pressure.map { p in p.what + (p.routes.isEmpty ? "" : " (\(p.routes.joined(separator: ", ")))") }.joined(separator: "; ")).")
    }
    if let run = e.run {
      let order = run.variant.map { ", in the order \($0)" } ?? ""
      lines.append("Result: \(verdict.word.lowercased()) in \(verdict.failed) of \(verdict.total) runs\(order).")
    }
    for rule in e.rules.broken {
      lines.append("Rule broken: \(rule.id)\(rule.description.map { ": \($0)" } ?? "")")
      if let example = rule.examples?.first ?? rule.sample { lines.append("  e.g. \(example)") }
    }
    if let error = e.run?.error { lines.append("Error: \(error)") }
    if let f = e.finding {
      lines.append("")
      lines.append("Why: \(f.cause)")
      if let fix = f.fix { lines.append("Suggested fix: \(fix)") }
      if !f.code.isEmpty { lines.append("Code: \(f.code.joined(separator: ", "))") }
    }
    lines.append("")
    lines.append("The test is the experiment `\(e.id)`\(file.map { " (\($0))" } ?? ""). Run it with `windtunnel run \(e.id)`; `windtunnel evidence <run>` shows a run's steps, requests and rules.")
    if e.finding == nil {
      lines.append("Once you know the cause, add it to the experiment file as `finding:` (cause, fix, code: [path:line]).")
    }
    lines.append("When it's fixed, prove it: `windtunnel prove \(e.id)` (it must break on HEAD and hold on your change in every order), then `windtunnel check` to make sure nothing else regressed.")
    return lines.joined(separator: "\n")
  }
}

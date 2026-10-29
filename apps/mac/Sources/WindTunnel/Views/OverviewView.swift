import SwiftUI

struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        Hero().rise()
        HStack(alignment: .top, spacing: 44) {
          AttentionPanel()
          RulesBroken().frame(width: 280)
        }
        .rise(0.05)
        HistoryPanel().rise(0.1)
      }
      .padding(.horizontal, 28)
      .padding(.top, 4)
      .padding(.bottom, 32)
      .frame(maxWidth: 1100, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.never)
  }
}

/// How the project stands: how many experiments hold, one bar split by outcome, and air running
/// through the tunnel behind it.
private struct Hero: View {
  @Environment(AppModel.self) private var model
  @State private var shown = 0

  var body: some View {
    let latest = model.latestByExperiment
    let outcomes = model.experiments.map { latest[$0.id]?.outcome ?? $0.last?.outcome ?? "none" }
    let passing = outcomes.filter { $0 == "pass" }.count
    let failing = outcomes.filter { $0 == "fail" }.count
    let flaky = outcomes.filter { $0 == "flaky" }.count
    let other = outcomes.count - passing - failing - flaky
    ZStack(alignment: .leading) {
      AsciiArt(scene: .tunnel(throat: 0.72, squeeze: 0.56, spacing: 2.2), fontSize: 7)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0.36), .init(color: .black, location: 0.7)], startPoint: .leading, endPoint: .trailing))
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("\(shown)")
            .font(Theme.figure(56))
            .foregroundStyle(Theme.text)
            .contentTransition(.numericText(value: Double(shown)))
          Text(outcomes.isEmpty ? "no experiments yet" : "of \(outcomes.count) experiments holding")
            .font(Theme.sans(16)).foregroundStyle(Theme.faint)
        }
        SplitBar(parts: [(passing, Theme.accent), (failing, Theme.fail), (flaky, Theme.flaky), (other, Color.white.opacity(0.12))])
          .frame(width: 340)
          .padding(.top, 14)
        Text(summary(failing: failing, flaky: flaky, other: other))
          .font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
          .padding(.top, 12)
      }
    }
    .frame(height: 140)
    .onAppear { withAnimation(.easeOut(duration: 0.8)) { shown = passing } }
    .onChange(of: passing) { withAnimation(Theme.spring) { shown = passing } }
  }

  private func summary(failing: Int, flaky: Int, other: Int) -> String {
    var parts: [String] = []
    if failing > 0 { parts.append("\(failing) failing") }
    let new = model.latestByExperiment.values.filter { $0.outcome == "fail" && model.streak(of: $0) == .new }.count
    if new > 0 { parts.append("\(new) just broke") }
    if flaky > 0 { parts.append("\(flaky) flaky") }
    if other > 0 { parts.append("\(other) not run") }
    if let last = model.runs.first { parts.append("last run \(Fmt.ago(last.started))") }
    return parts.joined(separator: "  ·  ")
  }
}

/// Failing and flaky experiments, by their newest run: what each broke, and whether it just
/// started.
private struct AttentionPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let bad = model.latestByExperiment.values
      .filter { $0.outcome == "fail" || $0.outcome == "flaky" || $0.outcome == "error" }
      .map { ($0, model.streak(of: $0)) }
      .sorted { a, b in
        // New failures first: they're the ones a change just caused.
        let x = a.1 == .new ? 0 : 1, y = b.1 == .new ? 0 : 1
        return x != y ? x < y : a.0.experiment < b.0.experiment
      }
    Panel("Needs attention", accessory: {
      if !bad.isEmpty { Text("\(bad.count)") }
    }) {
      if bad.isEmpty {
        Text("Every rule held on the newest runs.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
      } else {
        VStack(spacing: 0) {
          ForEach(bad, id: \.0.id) { run, streak in
            AttentionRow(run: run, streak: streak)
          }
        }
        .padding(.horizontal, -10)
      }
    }
  }
}

private struct AttentionRow: View {
  @Environment(AppModel.self) private var model
  let run: RunListEntry
  let streak: Streak?
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6)
      VStack(alignment: .leading, spacing: 3) {
        Text(run.experiment).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        Text(run.brokenRules.isEmpty ? Tone.word(run.outcome).lowercased() : run.brokenRules.joined(separator: ", "))
          .font(Theme.mono(11.5)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      Spacer(minLength: 12)
      if let streak {
        Text(streak.text)
          .font(Theme.sans(12, streak == .new ? .medium : .regular))
          .foregroundStyle(streak == .new ? Theme.fail : Theme.faint)
          .help(streak.help)
      }
      Image(systemName: "chevron.right").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(hovering ? Theme.dim : .clear)
    }
    .padding(.horizontal, 10)
    .frame(height: 48)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help("Failed \(Fmt.ago(run.started))")
    .onTapGesture {
      model.selectedRun = run.id
      model.section = .runs
    }
  }
}

/// The rules that broke, most often first, across every run listed.
private struct RulesBroken: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let tally = Self.tally(model.runs)
    let most = max(1, tally.first?.runs ?? 1)
    Panel("Rules broken", accessory: {
      if !tally.isEmpty { Text("runs") }
    }) {
      if tally.isEmpty {
        Text("None yet.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
      } else {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(tally.prefix(6), id: \.rule) { t in
            VStack(alignment: .leading, spacing: 6) {
              HStack(alignment: .firstTextBaseline) {
                Text(t.rule).font(Theme.mono(12)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 8)
                Text("\(t.runs)").font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.dim)
              }
              Meter(value: Double(t.runs) / Double(most), color: Theme.fail.opacity(0.6), height: 2)
            }
            .help("Broke in \(Fmt.plural(t.runs, "run")) of \(t.experiments.sorted().joined(separator: ", "))")
          }
          if tally.count > 6 {
            Text("and \(tally.count - 6) more").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
          }
        }
        .padding(.top, 2)
      }
    }
  }

  private static func tally(_ runs: [RunListEntry]) -> [(rule: String, runs: Int, experiments: Set<String>)] {
    var by: [String: (Int, Set<String>)] = [:]
    for r in runs {
      for rule in r.brokenRules {
        by[rule, default: (0, [])].0 += 1
        by[rule, default: (0, [])].1.insert(r.experiment)
      }
    }
    return by.map { (rule: $0.key, runs: $0.value.0, experiments: $0.value.1) }
      .sorted { $0.runs != $1.runs ? $0.runs > $1.runs : $0.rule < $1.rule }
  }
}

/// Every experiment's recent runs as a strip of cells, oldest to newest: failing ones first, so
/// it shows at a glance what broke once, what keeps breaking and what has always held.
private struct HistoryPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let by = model.runsByExperiment
    // As many cells as the busiest experiment has runs, between 12 and 24.
    let slots = min(24, max(12, by.values.map(\.count).max() ?? 0))
    let latest = model.latestByExperiment
    let names = Set(model.experiments.map(\.id)).union(by.keys)
    let rows = names.map { name in (name: name, runs: Array((by[name] ?? []).prefix(slots))) }
      .sorted { a, b in
        let fa = bad(latest[a.name]?.outcome), fb = bad(latest[b.name]?.outcome)
        if fa != fb { return fa }
        let na = failures(a.runs), nb = failures(b.runs)
        return na != nb ? na > nb : a.name < b.name
      }
    Panel("History", accessory: { Text(Fmt.plural(model.runs.count, "run")) }) {
      if rows.isEmpty {
        Text("No runs yet.").font(Theme.sans(12.5)).foregroundStyle(Theme.dim)
      } else {
        VStack(spacing: 0) {
          HStack(spacing: 20) {
            Text("Experiment").frame(width: 210, alignment: .leading)
            Text("Oldest to newest").frame(width: HistoryRow.width(slots), alignment: .leading)
            Text("Last broke").frame(maxWidth: .infinity, alignment: .leading)
            Text("Failed").frame(width: 70, alignment: .trailing)
          }
          .font(Theme.sans(11.5)).foregroundStyle(Theme.ghost)
          .padding(.horizontal, 10)
          .padding(.bottom, 6)
          ForEach(rows, id: \.name) { row in
            HistoryRow(name: row.name, runs: row.runs, slots: slots, failing: bad(latest[row.name]?.outcome))
          }
        }
        .padding(.horizontal, -10)
      }
    }
  }

  private func bad(_ outcome: String?) -> Bool { outcome == "fail" || outcome == "flaky" || outcome == "error" }
  private func failures(_ runs: [RunListEntry]) -> Int { runs.filter { bad($0.outcome) }.count }
}

private struct HistoryRow: View {
  @Environment(AppModel.self) private var model
  let name: String
  /// Newest first, at most `slots`.
  let runs: [RunListEntry]
  let slots: Int
  let failing: Bool
  @State private var hovering = false

  static let cell: CGFloat = 12
  static let gap: CGFloat = 3
  static func width(_ slots: Int) -> CGFloat { CGFloat(slots) * (cell + gap) - gap }

  var body: some View {
    let failed = runs.filter { $0.outcome != "pass" && $0.outcome != "running" }
    let finished = runs.filter { $0.outcome != "running" }
    HStack(spacing: 20) {
      Text(name)
        .font(Theme.sans(12.5, failing ? .medium : .regular))
        .foregroundStyle(failing ? Theme.text : Theme.dim)
        .lineLimit(1).truncationMode(.middle)
        .frame(width: 210, alignment: .leading)
        .contentShape(Rectangle())
        .onTapGesture {
          model.selectedExperiment = name
          model.section = .experiments
        }
      HStack(spacing: Self.gap) {
        ForEach(0..<max(0, slots - runs.count), id: \.self) { _ in
          Rectangle().fill(Color.white.opacity(0.03)).frame(width: Self.cell, height: 14)
        }
        ForEach(runs.reversed()) { run in
          Cell(run: run)
        }
      }
      Text(failed.first?.brokenRules.first ?? "")
        .font(Theme.mono(11.5)).foregroundStyle(Theme.faint)
        .lineLimit(1).truncationMode(.middle)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(failed.isEmpty ? "–" : "\(failed.count) of \(finished.count)")
        .font(Theme.sans(12)).monospacedDigit()
        .foregroundStyle(failed.isEmpty ? Theme.ghost : Theme.dim)
        .frame(width: 70, alignment: .trailing)
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .onHover { hovering = $0 }
  }

  private struct Cell: View {
    @Environment(AppModel.self) private var model
    let run: RunListEntry
    @State private var hovering = false

    var body: some View {
      Rectangle()
        .fill(color.opacity(hovering ? 1 : 0.85))
        .frame(width: HistoryRow.cell, height: 14)
        .overlay(Rectangle().strokeBorder(Theme.text.opacity(hovering ? 0.8 : 0), lineWidth: 1))
        .phaseAnimator(run.outcome == "running" ? [0.35, 1] : [1]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.8) }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help("\(Tone.word(run.outcome)) · \(Fmt.day(run.started)) \(Fmt.time(run.started))" + (run.brokenRules.isEmpty ? "" : "\nBroke \(run.brokenRules.joined(separator: ", "))"))
        .onTapGesture {
          model.selectedRun = run.id
          model.section = .runs
        }
    }

    /// Held in the hue, so the strip shows how much holds; the rest in their colours.
    private var color: Color {
      run.outcome == "pass" ? Theme.accent.opacity(0.5) : run.outcome == "running" ? Theme.accent : Tone(run.outcome).color
    }
  }
}

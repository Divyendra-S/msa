import SwiftUI

struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    if model.experiments.isEmpty && model.runs.isEmpty {
      FirstRun(stage: .noExperiments)
    } else if model.runs.isEmpty {
      FirstRun(stage: .neverRun)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 40) {
          Hero().rise()
          FailingPanel().rise(0.05)
          HStack(alignment: .top, spacing: 48) {
            HoldingPanel()
            RulesBroken().frame(width: 280)
          }
          .rise(0.1)
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 4)
        .padding(.bottom, 32)
        .frame(maxWidth: Theme.measure, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.never)
    }
  }
}

/// How the project stands: how many experiments hold, one bar split by outcome, and beside it how
/// that number moved, run by run.
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
    HStack(alignment: .center, spacing: 48) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("\(shown)")
            .font(Theme.figure(56))
            .foregroundStyle(Theme.text)
            .contentTransition(.numericText(value: Double(shown)))
          Text("of \(outcomes.count) experiments holding")
            .font(Theme.sans(15)).foregroundStyle(Theme.faint)
        }
        SplitBar(parts: [(passing, Theme.accent), (failing, Theme.fail), (flaky, Theme.flaky), (other, Theme.overlay(0.12))])
          .frame(width: 340)
          .padding(.top, 14)
        Text(summary(failing: failing, flaky: flaky, other: other))
          .font(Theme.sans(12)).foregroundStyle(Theme.faint)
          .padding(.top, 12)
      }
      .layoutPriority(1)
      HoldingChart(runs: model.runs, experiments: model.experiments.count)
        .frame(maxWidth: 520)
    }
    .frame(height: 150)
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

/// How many experiments held and how many failed after each run, oldest to newest: replays the
/// runs listed, each one updating its experiment's standing.
private struct HoldingChart: View {
  let runs: [RunListEntry]
  let experiments: Int

  var body: some View {
    let series = Self.series(runs)
    let top = Double(max(experiments, series.map { $0.held + $0.failed }.max() ?? 1, 1))
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text("After each run").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
        Spacer()
        if let last = series.last {
          Legend(color: Theme.accent, text: "\(last.held) holding")
          Legend(color: Theme.fail, text: "\(last.failed) failing").padding(.leading, 12)
        }
      }
      Canvas { context, size in
        guard series.count > 1 else { return }
        let w = size.width, h = size.height
        func x(_ i: Int) -> Double { Double(i) / Double(series.count - 1) * w }
        func y(_ v: Int) -> Double { h - Double(v) / top * (h - 2) - 1 }
        // Faint guides at the top and the bottom.
        for gy in [0.5, h - 0.5] {
          context.stroke(Path { $0.move(to: CGPoint(x: 0, y: gy)); $0.addLine(to: CGPoint(x: w, y: gy)) }, with: .color(Theme.line), lineWidth: 1)
        }
        for (key, color, fill) in [(\Point.held, Theme.accent, 0.2), (\Point.failed, Theme.fail, 0.12)] {
          var line = Path()
          line.move(to: CGPoint(x: 0, y: y(series[0][keyPath: key])))
          for i in 1..<series.count {
            line.addLine(to: CGPoint(x: x(i), y: y(series[i - 1][keyPath: key])))
            line.addLine(to: CGPoint(x: x(i), y: y(series[i][keyPath: key])))
          }
          var area = line
          area.addLine(to: CGPoint(x: w, y: h))
          area.addLine(to: CGPoint(x: 0, y: h))
          area.closeSubpath()
          context.fill(area, with: .linearGradient(Gradient(colors: [color.opacity(fill), color.opacity(0)]), startPoint: .zero, endPoint: CGPoint(x: 0, y: h)))
          context.stroke(line, with: .color(color.opacity(0.9)), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
          let end = CGPoint(x: w, y: y(series.last![keyPath: key]))
          context.fill(Path(ellipseIn: CGRect(x: end.x - 3, y: end.y - 3, width: 6, height: 6)), with: .color(color))
        }
      }
      .padding(.trailing, 3)
      HStack {
        Text(series.first.map { Fmt.day($0.at) } ?? "").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
        Spacer()
        Text(Fmt.plural(series.count, "run")).font(Theme.sans(11)).foregroundStyle(Theme.ghost)
        Spacer()
        Text("now").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
      }
    }
  }

  struct Point {
    let at: Date
    let held: Int
    let failed: Int
  }

  static func series(_ runs: [RunListEntry]) -> [Point] {
    var standing: [String: String] = [:]
    var out: [Point] = []
    for run in runs.reversed() where run.outcome != "running" {
      standing[run.experiment] = run.outcome
      let held = standing.values.filter { $0 == "pass" }.count
      out.append(Point(at: run.started, held: held, failed: standing.count - held))
    }
    return out
  }

  private struct Legend: View {
    let color: Color
    let text: String

    var body: some View {
      HStack(spacing: 6) {
        Circle().fill(color).frame(width: 6, height: 6)
        Text(text).font(Theme.sans(11)).monospacedDigit().foregroundStyle(Theme.dim)
      }
    }
  }
}

/// Failing and flaky experiments by their newest run, new failures first: what each broke, its
/// recent runs, and whether it just started. This is where to look.
private struct FailingPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let bad = model.latestByExperiment.values
      .filter { Self.bad($0.outcome) }
      .map { ($0, model.streak(of: $0)) }
      .sorted { a, b in
        // New failures first: they're the ones a change just caused.
        let x = a.1 == .new ? 0 : 1, y = b.1 == .new ? 0 : 1
        return x != y ? x < y : a.0.experiment < b.0.experiment
      }
    Panel("Failing", tint: bad.isEmpty ? nil : Theme.text, accessory: {
      if !bad.isEmpty {
        Text("\(bad.count)").monospacedDigit().foregroundStyle(Theme.fail)
          .help("Each experiment's newest run. The cells are its recent runs, oldest to newest.")
      }
    }) {
      if bad.isEmpty {
        HStack(spacing: 10) {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.accent)
          Text("Every rule held on each experiment's newest run.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
        }
      } else {
        // As many cells as the busiest of them has runs, between 6 and 14.
        let slots = min(14, max(6, bad.map { model.runsByExperiment[$0.0.experiment]?.count ?? 0 }.max() ?? 0))
        VStack(spacing: 0) {
          ForEach(bad, id: \.0.id) { run, streak in
            FailingRow(run: run, streak: streak, slots: slots)
          }
        }
        .padding(.horizontal, -10)
      }
    }
  }

  static func bad(_ outcome: String?) -> Bool { outcome == "fail" || outcome == "flaky" || outcome == "error" }
}

private struct FailingRow: View {
  @Environment(AppModel.self) private var model
  let run: RunListEntry
  let streak: Streak?
  let slots: Int
  @State private var hovering = false

  var body: some View {
    let history = Array((model.runsByExperiment[run.experiment] ?? []).prefix(slots))
    HStack(spacing: 0) {
      Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6).frame(width: 18, alignment: .leading)
      VStack(alignment: .leading, spacing: 4) {
        Text(run.experiment).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        Text(run.brokenRules.isEmpty ? Tone.word(run.outcome).lowercased() : run.brokenRules.joined(separator: ", "))
          .font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      .frame(width: 240, alignment: .leading)
      // What the experiment does, in its own words.
      Text(model.experiments.first { $0.id == run.experiment }?.description ?? "")
        .font(Theme.sans(12)).foregroundStyle(hovering ? Theme.dim : Theme.faint).lineSpacing(2)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.trailing, 24)
      RunStrip(runs: history, slots: slots, cell: CGSize(width: 9, height: 16))
      Text(streak?.text ?? "")
        .font(Theme.sans(12, streak == .new ? .medium : .regular))
        .foregroundStyle(streak == .new ? Theme.fail : Theme.faint)
        .frame(width: 76, alignment: .trailing)
        .help(streak?.help ?? "")
    }
    .padding(.horizontal, 10)
    .frame(height: 58)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help("Failed \(Fmt.ago(run.started)). Open the run.")
    .onTapGesture {
      model.selectedRun = run.id
      model.section = .runs
    }
  }
}

/// The experiments that hold, quietly: two columns of names, each with its recent runs.
private struct HoldingPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let latest = model.latestByExperiment
    let by = model.runsByExperiment
    let names = Set(model.experiments.map(\.id)).union(by.keys)
      .filter { !FailingPanel.bad(latest[$0]?.outcome) }
      .sorted()
    Panel("Holding", accessory: { Text("\(names.count)") }) {
      if names.isEmpty {
        Text("None yet.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
      } else {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 28), GridItem(.flexible(), spacing: 28)], alignment: .leading, spacing: 0) {
          ForEach(names, id: \.self) { name in
            HoldingRow(name: name, runs: Array((by[name] ?? []).prefix(10)), description: model.experiments.first { $0.id == name }?.description)
          }
        }
        .padding(.horizontal, -8)
      }
    }
  }
}

private struct HoldingRow: View {
  @Environment(AppModel.self) private var model
  let name: String
  let runs: [RunListEntry]
  let description: String?
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Text(name)
        .font(Theme.sans(12))
        .foregroundStyle(hovering ? Theme.text : Theme.dim)
        .lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 8)
      if runs.isEmpty {
        Text("not run").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
      } else {
        RunStrip(runs: runs, slots: 10, cell: CGSize(width: 5, height: 12), gap: 2)
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 30)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help(description ?? name)
    .onTapGesture {
      model.selectedExperiment = name
      model.section = .experiments
    }
  }
}

/// An experiment's recent runs as cells, oldest to newest (`runs` newest first); empty slots faint.
/// Held runs are in the hue, so a strip shows how much holds; a cell opens its run.
private struct RunStrip: View {
  let runs: [RunListEntry]
  let slots: Int
  var cell = CGSize(width: 10, height: 14)
  var gap: CGFloat = 3

  var body: some View {
    HStack(spacing: gap) {
      ForEach(0..<max(0, slots - runs.count), id: \.self) { _ in
        Rectangle().fill(Theme.overlay(0.04)).frame(width: cell.width, height: cell.height)
      }
      ForEach(runs.prefix(slots).reversed()) { run in
        RunCell(run: run, size: cell)
      }
    }
  }
}

private struct RunCell: View {
  @Environment(AppModel.self) private var model
  let run: RunListEntry
  let size: CGSize
  @State private var hovering = false

  var body: some View {
    Rectangle()
      .fill(color.opacity(hovering ? 1 : 0.85))
      .frame(width: size.width, height: size.height)
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

  private var color: Color {
    run.outcome == "pass" ? Theme.accent.opacity(0.45) : run.outcome == "running" ? Theme.accent : Tone(run.outcome).color
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

// MARK: - First run

/// A project with nothing to show yet: the next step, big.
private struct FirstRun: View {
  enum Stage { case noExperiments, neverRun }

  @Environment(AppModel.self) private var model
  let stage: Stage

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch stage {
      case .noExperiments: noExperiments
      case .neverRun: neverRun
      }
    }
    .frame(width: 520, alignment: .leading)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var noExperiments: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Set up. Now find what breaks.")
        .font(.system(size: 30, weight: .semibold)).tracking(-0.6).foregroundStyle(Theme.text)
        .rise()
      Text("Experiments are written by your coding agent. On a hunt it reads the app, picks a risky flow such as checkout, and tries what users do by accident: two tabs, a double click, a lost response, a late webhook. Each one it keeps is a file you commit.")
        .font(Theme.sans(14)).foregroundStyle(Theme.dim).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 14)
        .rise(0.04)
      HStack(spacing: 10) {
        Button {
          model.section = .hunt
        } label: {
          Label("Start a Hunt", systemImage: "scope")
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
        Button("Copy /windtunnel:hunt checkout") { model.copy("/windtunnel:hunt checkout") }
          .buttonStyle(LinkButtonStyle())
          .padding(.leading, 6)
      }
      .padding(.top, 28)
      .rise(0.08)
    }
  }

  private var neverRun: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("\(Fmt.plural(model.experiments.count, "experiment")), not run yet.")
        .font(.system(size: 30, weight: .semibold)).tracking(-0.6).foregroundStyle(Theme.text)
        .rise()
      Text("Each runs against its own copy of the app and the database, as many times and in as many orders as it asks for. The first run builds the app once, which takes a minute or two. No model is involved.")
        .font(Theme.sans(14)).foregroundStyle(Theme.dim).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 14)
        .rise(0.04)
      Button {
        model.runExperiments([])
      } label: {
        Label(model.runningJob != nil ? "Running…" : "Run All", systemImage: "play.fill")
      }
      .buttonStyle(ActionButtonStyle(prominent: true))
      .disabled(model.runningJob != nil)
      .padding(.top, 28)
      .rise(0.08)
      VStack(alignment: .leading, spacing: 6) {
        ForEach(model.experiments.prefix(8)) { e in
          Text(e.id).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
        }
        if model.experiments.count > 8 {
          Text("and \(model.experiments.count - 8) more").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
        }
      }
      .padding(.top, 32)
      .rise(0.12)
    }
  }
}

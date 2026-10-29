import SwiftUI

struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Hero().rise()
        HStack(alignment: .top, spacing: 16) {
          AttentionPanel()
          BrokenRulesPanel()
        }
        .rise(0.06)
        HistoryPanel().rise(0.12)
      }
      .padding(.horizontal, 22)
      .padding(.top, 4)
      .padding(.bottom, 24)
      .frame(maxWidth: 1180, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.never)
  }
}

/// How the project stands: how many experiments hold, split by outcome, with the orb.
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
      AsciiArt(scene: .orb(center: UnitPoint(x: 0.76, y: 0.5), radius: 0.3), fontSize: 7)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0.38), .init(color: .black, location: 0.62)], startPoint: .leading, endPoint: .trailing))
      VStack(alignment: .leading, spacing: 0) {
        Text("Holding").label()
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("\(shown)")
            .font(Theme.figure(60))
            .foregroundStyle(Theme.text)
            .contentTransition(.numericText(value: Double(shown)))
          Text(outcomes.isEmpty ? "no experiments yet" : "of \(outcomes.count)")
            .font(Theme.sans(17)).foregroundStyle(Theme.faint)
        }
        .padding(.top, 2)
        SplitBar(parts: [(passing, Theme.pass), (failing, Theme.fail), (flaky, Theme.flaky), (other, Color.white.opacity(0.14))])
          .frame(width: 320)
          .padding(.top, 14)
        HStack(spacing: 16) {
          if failing > 0 { legend(failing, "failing", Theme.fail) }
          if flaky > 0 { legend(flaky, "flaky", Theme.flaky) }
          if other > 0 { legend(other, "not run", Theme.ghost) }
          if let last = model.runs.first {
            Text("Last run \(Fmt.ago(last.started))").font(Theme.sans(12)).foregroundStyle(Theme.faint)
          }
        }
        .padding(.top, 14)
      }
      .padding(26)
    }
    .frame(height: 218)
    .frame(maxWidth: .infinity)
    .card(radius: 20)
    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    .onAppear { withAnimation(.easeOut(duration: 0.8)) { shown = passing } }
    .onChange(of: passing) { withAnimation(Theme.spring) { shown = passing } }
  }

  private func legend(_ n: Int, _ word: String, _ color: Color) -> some View {
    HStack(spacing: 6) {
      Circle().fill(color).frame(width: 6, height: 6)
      Text("\(n) \(word)").font(Theme.sans(12, .medium)).foregroundStyle(Theme.dim)
    }
  }
}

/// Failing and flaky experiments, by their newest run.
private struct AttentionPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let bad = model.latestByExperiment.values
      .filter { $0.outcome == "fail" || $0.outcome == "flaky" || $0.outcome == "error" }
      .sorted { $0.experiment < $1.experiment }
    Panel("Needs attention", accessory: {
      if !bad.isEmpty { Text("\(bad.count)") }
    }) {
      if bad.isEmpty {
        HStack(spacing: 8) {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.pass)
          Text("Every rule held on the newest runs.").foregroundStyle(Theme.dim)
        }
        .font(Theme.sans(12.5))
      } else {
        VStack(spacing: 0) {
          ForEach(bad) { run in
            AttentionRow(run: run)
          }
        }
        .padding(.horizontal, -8)
      }
    }
    .frame(maxWidth: .infinity)
  }
}

private struct AttentionRow: View {
  @Environment(AppModel.self) private var model
  let run: RunListEntry
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Circle().fill(Tone(run.outcome).color).frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 2) {
        Text(run.experiment).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
        Text(run.brokenRules.isEmpty ? (run.headline ?? run.outcome) : run.brokenRules.joined(separator: ", "))
          .font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      Spacer()
      Text(Fmt.ago(run.started)).font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
      Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(hovering ? Theme.dim : Theme.ghost)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(hovering ? Color.white.opacity(0.05) : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture {
      model.selectedRun = run.id
      model.section = .runs
    }
    .animation(Theme.snappy, value: hovering)
  }
}

/// Which rules break most, across each experiment's newest run.
private struct BrokenRulesPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    var counts: [String: Int] = [:]
    for run in model.latestByExperiment.values { for rule in run.brokenRules { counts[rule, default: 0] += 1 } }
    let ranked = counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
    let top = ranked.first?.value ?? 1
    return Panel("Rules broken") {
      if ranked.isEmpty {
        Text("None right now.").font(Theme.sans(12.5)).foregroundStyle(Theme.dim)
      } else {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(ranked, id: \.key) { rule, n in
            VStack(alignment: .leading, spacing: 7) {
              HStack {
                Text(rule).font(Theme.mono(11.5)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
                Spacer()
                Text("\(n)").font(Theme.sans(12, .semibold)).monospacedDigit().foregroundStyle(Theme.fail)
              }
              Meter(value: Double(n) / Double(top), color: Theme.fail, height: 3)
            }
            .help("Broken in the newest run of \(n) experiment\(n == 1 ? "" : "s")")
          }
        }
      }
    }
    .frame(width: 340)
  }
}

/// Every batch of runs over time, as a dot-matrix: one column per batch, a dot per run,
/// failures on top.
private struct HistoryPanel: View {
  @Environment(AppModel.self) private var model
  @State private var hover: Batch?

  var body: some View {
    let batches = Array(model.batches.prefix(56).reversed())
    let tallest = max(1, batches.map(\.runs.count).max() ?? 1)
    Panel("History", accessory: {
      Text(hover.map { "\(Fmt.day($0.started)) \(Fmt.clock($0.started)) · \(Fmt.plural($0.runs.count, "run")) · \($0.count("fail")) failed" } ?? Fmt.plural(model.batches.count, "batch", "batches"))
        .contentTransition(.opacity)
    }) {
      if batches.isEmpty {
        Text("No runs yet.").font(Theme.sans(12.5)).foregroundStyle(Theme.dim)
      } else {
        // At most twelve dots a column: past that, each dot stands for several runs.
        let unit = max(1, Int((Double(tallest) / 12).rounded(.up)))
        let gap: CGFloat = 2.5
        let rows = min(12, tallest)
        let dot = min(7, (86 - gap * CGFloat(rows - 1)) / CGFloat(rows))
        HStack(alignment: .bottom, spacing: 5) {
          ForEach(batches) { batch in
            let sorted = batch.runs.sorted { rank($0.outcome) < rank($1.outcome) }
            let shown = stride(from: 0, to: sorted.count, by: unit).map { sorted[$0] }
            VStack(spacing: gap) {
              ForEach(shown) { run in
                Circle()
                  .fill(Tone(run.outcome).color.opacity(hover == nil || hover == batch ? 0.95 : 0.3))
                  .frame(width: dot, height: dot)
              }
            }
            .frame(width: 7, height: 86, alignment: .bottom)
            .contentShape(Rectangle())
            .onHover { inside in withAnimation(Theme.snappy) { hover = inside ? batch : (hover == batch ? nil : hover) } }
            .onTapGesture {
              model.selectedRun = (sorted.first { $0.outcome != "pass" } ?? sorted.first)?.id
              model.section = .runs
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
      }
    }
  }

  private func rank(_ outcome: String) -> Int {
    switch outcome {
    case "fail": 0
    case "error": 1
    case "flaky": 2
    case "running": 3
    default: 4
    }
  }
}

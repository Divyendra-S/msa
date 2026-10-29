import SwiftUI

struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        Hero().rise()
        AttentionPanel().rise(0.05)
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
    .frame(height: 170)
    .onAppear { withAnimation(.easeOut(duration: 0.8)) { shown = passing } }
    .onChange(of: passing) { withAnimation(Theme.spring) { shown = passing } }
  }

  private func summary(failing: Int, flaky: Int, other: Int) -> String {
    var parts: [String] = []
    if failing > 0 { parts.append("\(failing) failing") }
    if flaky > 0 { parts.append("\(flaky) flaky") }
    if other > 0 { parts.append("\(other) not run") }
    if let last = model.runs.first { parts.append("last run \(Fmt.ago(last.started))") }
    return parts.joined(separator: "  ·  ")
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
        Text("Every rule held on the newest runs.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
      } else {
        VStack(spacing: 0) {
          ForEach(bad) { run in
            AttentionRow(run: run)
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
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6)
      Text(run.experiment).font(Theme.sans(13)).foregroundStyle(Theme.text).lineLimit(1)
      Text(run.brokenRules.isEmpty ? Tone.word(run.outcome).lowercased() : run.brokenRules.joined(separator: ", "))
        .font(Theme.mono(11.5)).foregroundStyle(Theme.faint).lineLimit(1)
      Spacer(minLength: 12)
      Text(Fmt.ago(run.started)).font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.ghost)
      Image(systemName: "chevron.right").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(hovering ? Theme.dim : .clear)
    }
    .padding(.horizontal, 10)
    .frame(height: 34)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture {
      model.selectedRun = run.id
      model.section = .runs
    }
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
        let dot = min(6, (86 - gap * CGFloat(rows - 1)) / CGFloat(rows))
        HStack(alignment: .bottom, spacing: 5) {
          ForEach(batches) { batch in
            let sorted = batch.runs.sorted { rank($0.outcome) < rank($1.outcome) }
            let shown = stride(from: 0, to: sorted.count, by: unit).map { sorted[$0] }
            VStack(spacing: gap) {
              ForEach(shown) { run in
                RoundedRectangle(cornerRadius: 1)
                  .fill(color(run.outcome).opacity(hover == nil || hover == batch ? 1 : 0.3))
                  .frame(width: dot, height: dot)
              }
            }
            .frame(width: 6, height: 86, alignment: .bottom)
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

  /// Held runs in the hue, so the chart shows how much passes; the rest in their colours.
  private func color(_ outcome: String) -> Color {
    outcome == "pass" ? Theme.accent.opacity(0.6) : Tone(outcome).color
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

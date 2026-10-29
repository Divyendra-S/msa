import SwiftUI

struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let latest = model.latestByExperiment
    let outcomes = model.experiments.map { latest[$0.id]?.outcome ?? $0.last?.outcome ?? "none" }
    let passing = outcomes.filter { $0 == "pass" }.count
    let failing = outcomes.filter { $0 == "fail" }.count
    let flaky = outcomes.filter { $0 == "flaky" }.count
    let never = outcomes.filter { $0 == "none" }.count
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        Hero(passing: passing, total: model.experiments.count)
        HStack(spacing: 14) {
          StatTile(label: "experiments", value: model.experiments.count, detail: never > 0 ? "\(never) never run" : "all have run", color: Theme.text, fraction: 1)
          StatTile(label: "holding", value: passing, detail: "every rule held", color: Theme.pass, fraction: ratio(passing, model.experiments.count))
          StatTile(label: "failing", value: failing, detail: failing == 0 ? "nothing broken" : "a rule broke", color: Theme.fail, fraction: ratio(failing, model.experiments.count))
          StatTile(label: "flaky", value: flaky, detail: "breaks sometimes", color: Theme.flaky, fraction: ratio(flaky, model.experiments.count))
        }
        .rise(0.05)
        HStack(alignment: .top, spacing: 14) {
          AttentionPanel()
          BrokenRulesPanel()
        }
        .rise(0.1)
        HistoryPanel().rise(0.15)
      }
      .padding(24)
      .frame(maxWidth: 1180, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.never)
    .background(DotGrid().ignoresSafeArea())
  }

  private func ratio(_ a: Int, _ b: Int) -> Double { b == 0 ? 0 : Double(a) / Double(b) }
}

private struct Hero: View {
  @Environment(AppModel.self) private var model
  let passing: Int
  let total: Int

  var body: some View {
    ZStack(alignment: .leading) {
      AirflowField(fontSize: 10, color: Theme.accent, center: CGPoint(x: 0.72, y: 0.5), radius: 0.2, lines: 11)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0.18), .init(color: .black, location: 0.55), .init(color: .black, location: 1)], startPoint: .leading, endPoint: .trailing))
      VStack(alignment: .leading, spacing: 10) {
        Text("project").label()
        ScrambleText(text: model.status?.project.name ?? "", font: Theme.mono(30, .bold), color: Theme.text, duration: 0.7)
        Text(Fmt.tilde(model.status?.project.root ?? "")).font(Theme.mono(11)).foregroundStyle(Theme.faint)
        HStack(spacing: 10) {
          AsciiBar(value: total == 0 ? 0 : Double(passing) / Double(total), width: 24, color: Theme.pass)
          Text(total == 0 ? "no experiments yet" : "\(passing)/\(total) holding")
            .font(Theme.mono(11)).foregroundStyle(Theme.dim)
            .contentTransition(.numericText())
        }
        .padding(.top, 4)
        HStack(spacing: 8) {
          if let last = model.runs.first {
            Chip(text: "last run \(Fmt.ago(last.started))")
          }
          Chip(text: "\(model.runs.count) runs kept")
          if let budget = model.status?.budget {
            Chip(text: "budget \(Fmt.kilo(budget.tokens)) tok · \(Fmt.usd(budget.usd))")
          }
        }
      }
      .padding(24)
    }
    .frame(height: 220)
    .frame(maxWidth: .infinity)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface.opacity(0.6)))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.lineStrong))
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

private struct StatTile: View {
  let label: String
  let value: Int
  let detail: String
  let color: Color
  let fraction: Double
  @State private var shown = 0

  var body: some View {
    Panel(label, titleColor: color == Theme.text ? Theme.dim : color.opacity(0.9)) {
      VStack(alignment: .leading, spacing: 6) {
        Text("\(shown)")
          .font(Theme.mono(34, .semibold))
          .foregroundStyle(color)
          .contentTransition(.numericText(value: Double(shown)))
        AsciiBar(value: fraction, width: 14, color: color.opacity(0.85), font: Theme.mono(9))
        Text(detail).font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
      }
    }
    .onAppear { withAnimation(.easeOut(duration: 0.8)) { shown = value } }
    .onChange(of: value) { withAnimation(Theme.spring) { shown = value } }
  }
}

/// Failing and flaky experiments, by their newest run.
private struct AttentionPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let bad = model.latestByExperiment.values
      .filter { $0.outcome == "fail" || $0.outcome == "flaky" || $0.outcome == "error" }
      .sorted { $0.experiment < $1.experiment }
    Panel("needs attention", accessory: {
      Text("\(bad.count)").font(Theme.mono(10)).foregroundStyle(bad.isEmpty ? Theme.pass : Theme.fail)
    }) {
      if bad.isEmpty {
        HStack(spacing: 8) {
          Text("●").foregroundStyle(Theme.pass)
          Text("Every experiment's newest run held every rule.").foregroundStyle(Theme.dim)
        }
        .font(Theme.mono(11.5))
        .padding(.vertical, 6)
      } else {
        VStack(spacing: 2) {
          ForEach(bad) { run in
            AttentionRow(run: run)
          }
        }
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
    HStack(spacing: 10) {
      Text(Tone(run.outcome).glyph).font(Theme.mono(12, .bold)).foregroundStyle(Tone(run.outcome).color).frame(width: 14)
      VStack(alignment: .leading, spacing: 2) {
        Text(run.experiment).font(Theme.mono(12, .medium)).foregroundStyle(Theme.text)
        Text(run.brokenRules.isEmpty ? (run.headline ?? run.outcome) : run.brokenRules.joined(separator: " · "))
          .font(Theme.mono(10.5)).foregroundStyle(Tone(run.outcome).color.opacity(0.85)).lineLimit(1)
      }
      Spacer()
      Text(Fmt.ago(run.started)).font(Theme.mono(10)).foregroundStyle(Theme.faint)
      Image(systemName: "arrow.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(hovering ? Theme.accent : Theme.ghost)
        .offset(x: hovering ? 2 : 0)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 7)
    .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? Theme.raised : .clear))
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
    return Panel("rules broken", accessory: {
      Text("by experiment").font(Theme.mono(10)).foregroundStyle(Theme.faint)
    }) {
      if ranked.isEmpty {
        Text("No rule is broken right now.").font(Theme.mono(11.5)).foregroundStyle(Theme.dim).padding(.vertical, 6)
      } else {
        VStack(alignment: .leading, spacing: 9) {
          ForEach(ranked, id: \.key) { rule, n in
            VStack(alignment: .leading, spacing: 3) {
              HStack {
                Text(rule).font(Theme.mono(11.5)).foregroundStyle(Theme.text)
                Spacer()
                Text("\(n)").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.fail)
              }
              AsciiBar(value: Double(n) / Double(top), width: 30, color: Theme.fail.opacity(0.8), font: Theme.mono(8))
            }
          }
        }
      }
    }
    .frame(width: 380)
  }
}

/// Every batch of runs over time: one column per batch, a block per run, failures on top.
private struct HistoryPanel: View {
  @Environment(AppModel.self) private var model
  @State private var hover: Batch?

  var body: some View {
    let batches = Array(model.batches.prefix(48).reversed())
    let tallest = max(1, batches.map(\.runs.count).max() ?? 1)
    Panel("history", accessory: {
      Text(hover.map { "\(Fmt.day($0.started)) \(Fmt.clock($0.started)) · \($0.runs.count) runs · \($0.count("fail")) fail" } ?? "\(model.batches.count) batches")
        .font(Theme.mono(10)).foregroundStyle(Theme.faint)
        .contentTransition(.numericText())
    }) {
      if batches.isEmpty {
        Text("No runs yet. Run all, or start a hunt.").font(Theme.mono(11.5)).foregroundStyle(Theme.dim)
      } else {
        let gap: CGFloat = tallest > 20 ? 1 : 2
        let block = max(1.2, (88 - gap * CGFloat(tallest - 1)) / CGFloat(tallest))
        HStack(alignment: .bottom, spacing: 5) {
          ForEach(batches) { batch in
            let sorted = batch.runs.sorted { rank($0.outcome) < rank($1.outcome) }
            VStack(spacing: gap) {
              ForEach(sorted) { run in
                RoundedRectangle(cornerRadius: min(1.5, block / 2))
                  .fill(Tone(run.outcome).color.opacity(hover == nil || hover == batch ? 0.9 : 0.35))
                  .frame(width: 12, height: block)
              }
            }
            .frame(height: 90, alignment: .bottom)
            .clipped()
            .contentShape(Rectangle())
            .onHover { inside in withAnimation(Theme.snappy) { hover = inside ? batch : (hover == batch ? nil : hover) } }
            .onTapGesture {
              model.selectedRun = (sorted.first { $0.outcome != "pass" } ?? sorted.first)?.id
              model.section = .runs
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        HStack {
          Text(batches.first.map { Fmt.day($0.started) } ?? "").font(Theme.mono(9.5)).foregroundStyle(Theme.faint)
          Spacer()
          Text("now").font(Theme.mono(9.5)).foregroundStyle(Theme.faint)
        }
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

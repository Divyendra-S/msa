import SwiftUI

struct RunsSplit: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 0) {
      RunsList()
        .frame(width: 292)
      Hairline(vertical: true)
      Group {
        if let id = model.selectedRun ?? defaultRun {
          RunDetailView(runID: id).id(id)
        } else {
          EmptyState(title: "No runs yet", text: "Runs appear here as they start, from Run all, a hunt, or your agent.")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  /// The newest batch's most telling run.
  private var defaultRun: String? {
    guard let batch = model.batches.first else { return nil }
    return (batch.runs.first { $0.outcome == "fail" } ?? batch.runs.first { $0.outcome == "flaky" } ?? batch.runs.first)?.id
  }
}

private enum RunFilter: String, CaseIterable {
  case all, fail, flaky, pass

  var title: String {
    switch self {
    case .all: "All"
    case .fail: "Failed"
    case .flaky: "Flaky"
    case .pass: "Passed"
    }
  }
}

struct RunsList: View {
  @Environment(AppModel.self) private var model
  @State private var filter: RunFilter = .all
  @State private var query = ""
  /// Batches whose held runs are unfolded.
  @State private var unfolded: Set<String> = []

  var body: some View {
    VStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        SearchField(text: $query, prompt: "Filter")
        TabStrip(items: RunFilter.allCases, selection: $filter, size: 12) { f, _ in
          Text(f.title)
        }
        .padding(.leading, 4)
      }
      .padding(.horizontal, 12)
      .padding(.top, 4)
      Hairline()

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(filtered.enumerated()), id: \.element.id) { i, batch in
            let bad = batch.runs.filter { $0.outcome != "pass" }.sorted { rank($0.outcome) < rank($1.outcome) }
            let held = batch.runs.filter { $0.outcome == "pass" }
            let fold = folds(held)
            Section {
              ForEach(bad) { run in
                row(run)
              }
              if fold {
                FoldRow(count: held.count, open: unfolded.contains(batch.id)) {
                  withAnimation(Theme.snappy) {
                    if unfolded.contains(batch.id) { unfolded.remove(batch.id) } else { unfolded.insert(batch.id) }
                  }
                }
              }
              if !fold || unfolded.contains(batch.id) {
                ForEach(held) { run in
                  row(run)
                }
              }
            } header: {
              BatchHeader(batch: batch, first: i == 0)
            }
          }
          if filtered.isEmpty {
            Text(model.runs.isEmpty ? "No runs yet." : "Nothing matches.")
              .font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
              .frame(maxWidth: .infinity).padding(.top, 30)
          }
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 12)
      }
      .scrollIndicators(.never)
    }
  }

  private func row(_ run: RunListEntry) -> some View {
    RunRow(run: run, selected: model.selectedRun == run.id, streak: run.outcome == "pass" ? nil : model.streak(of: run))
      // Rows in a lazy section can keep an old rendering: rebuild one when its run moves on.
      .id("\(run.id)·\(run.outcome)·\(run.running?.done ?? -1)")
      .onTapGesture { withAnimation(Theme.snappy) { model.selectedRun = run.id } }
  }

  /// Held runs fold under one row when there are a few of them, so what failed is what you see;
  /// not while filtering, and never over the selected run.
  private func folds(_ held: [RunListEntry]) -> Bool {
    filter == .all && query.isEmpty && held.count >= 3 && !held.contains { $0.id == model.selectedRun }
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

  private var filtered: [Batch] {
    let q = query.lowercased()
    return model.batches.compactMap { batch in
      var b = batch
      b.runs = batch.runs.filter { r in
        (filter == .all || r.outcome == filter.rawValue)
          && (q.isEmpty || r.experiment.lowercased().contains(q) || (r.headline ?? "").lowercased().contains(q)
            || r.brokenRules.contains { $0.lowercased().contains(q) })
      }
      return b.runs.isEmpty ? nil : b
    }
  }
}

/// When a batch started, and how it went: how many failed, or that all held.
private struct BatchHeader: View {
  let batch: Batch
  let first: Bool

  var body: some View {
    let failed = batch.runs.filter { $0.outcome != "pass" && $0.outcome != "running" }.count
    let running = batch.count("running")
    VStack(spacing: 0) {
      if !first { Hairline().padding(.horizontal, 10).padding(.bottom, 14) }
      HStack(spacing: 8) {
        Text("\(Fmt.day(batch.started).capitalized), \(Fmt.time(batch.started))")
          .font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.dim)
        Spacer()
        if running > 0 {
          BrailleSpinner(size: 9)
          Text("\(running) running").foregroundStyle(Theme.accent)
        } else if failed > 0 {
          Text("\(failed) failed").foregroundStyle(Theme.fail) + Text(" of \(batch.runs.count)").foregroundStyle(Theme.ghost)
        } else {
          Text(batch.runs.count == 1 ? "held" : "all \(batch.runs.count) held").foregroundStyle(Theme.ghost)
        }
      }
      .font(Theme.sans(11.5))
      .monospacedDigit()
      .padding(.horizontal, 10)
      .padding(.bottom, 6)
    }
    .padding(.top, first ? 12 : 10)
  }
}

/// A run: failures on two lines, the rule they broke under the name; held runs quiet, on one.
private struct RunRow: View {
  let run: RunListEntry
  let selected: Bool
  let streak: Streak?
  @State private var hovering = false

  var body: some View {
    let tone = Tone(run.outcome)
    let loud = tone == .fail || tone == .error || tone == .flaky
    HStack(alignment: loud ? .top : .center, spacing: 10) {
      Group {
        if run.outcome == "running" {
          BrailleSpinner(size: 10)
        } else {
          Circle().fill(tone.color).frame(width: 6, height: 6)
        }
      }
      .frame(width: 10, height: loud ? 17 : nil)
      VStack(alignment: .leading, spacing: 2) {
        Text(run.experiment)
          .font(Theme.sans(13, loud || selected ? .medium : .regular))
          .foregroundStyle(loud || selected ? Theme.text : Theme.faint)
          .lineLimit(1)
        if loud {
          Text(run.brokenRules.isEmpty ? Tone.word(run.outcome).lowercased() : run.brokenRules.joined(separator: ", "))
            .font(Theme.mono(11)).foregroundStyle(Theme.faint)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 6)
      if let progress = run.running {
        Text("\(progress.done)/\(progress.total)").font(Theme.sans(11.5)).monospacedDigit().foregroundStyle(Theme.accent)
      } else if streak == .new {
        Text("new").font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.fail)
          .frame(height: 17)
          .help(Streak.new.help)
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, loud ? 7 : 0)
    .frame(minHeight: loud ? 46 : 28)
    .background {
      RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
        .fill(selected ? Theme.selection : hovering ? Theme.hover : .clear)
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help("\(Tone.word(run.outcome)) · \(Fmt.ago(run.started))" + (streak.map { "\n\($0.help)" } ?? ""))
  }
}

/// `› 12 held`: the batch's runs that held, folded.
private struct FoldRow: View {
  let count: Int
  let open: Bool
  let toggle: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 10) {
        Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .semibold))
          .rotationEffect(.degrees(open ? 90 : 0))
          .frame(width: 10)
        Text("\(count) held").font(Theme.sans(12.5))
        Spacer()
      }
      .foregroundStyle(hovering ? Theme.dim : Theme.faint)
      .padding(.horizontal, 10)
      .frame(height: 28)
      .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

struct SearchField: View {
  @Binding var text: String
  var prompt: String
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 7) {
      Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .medium)).foregroundStyle(focused ? Theme.dim : Theme.faint)
      TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Theme.faint))
        .textFieldStyle(.plain)
        .font(Theme.sans(12.5))
        .foregroundStyle(Theme.text)
        .focused($focused)
      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.faint)
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 28)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(focused ? Theme.fill : Theme.overlay(0.035)))
    .animation(Theme.snappy, value: focused)
  }
}

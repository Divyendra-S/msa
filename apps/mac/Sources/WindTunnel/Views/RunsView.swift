import SwiftUI

struct RunsSplit: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 0) {
      RunsList()
        .frame(width: 304)
        .card(radius: 18)
        .padding(.bottom, 8)
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

  var body: some View {
    VStack(spacing: 0) {
      VStack(spacing: 10) {
        Segmented(items: RunFilter.allCases, selection: $filter) { f, _ in
          Text(f.title)
        }
        SearchField(text: $query, prompt: "Filter by experiment or rule")
      }
      .padding(12)

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 1) {
          ForEach(filtered) { batch in
            Section {
              ForEach(batch.runs) { run in
                RunRow(run: run, selected: model.selectedRun == run.id)
                  // Rows in a lazy section can keep an old rendering: rebuild one when its run moves on.
                  .id("\(run.id)·\(run.outcome)·\(run.running?.done ?? -1)")
                  .onTapGesture { withAnimation(Theme.snappy) { model.selectedRun = run.id } }
              }
            } header: {
              BatchHeader(batch: batch)
            }
          }
          if filtered.isEmpty {
            Text(model.runs.isEmpty ? "No runs yet." : "Nothing matches.")
              .font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
              .frame(maxWidth: .infinity).padding(.top, 30)
          }
        }
        .padding(.horizontal, 6)
        .padding(.bottom, 12)
      }
      .scrollIndicators(.never)
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

private struct BatchHeader: View {
  let batch: Batch

  var body: some View {
    HStack(spacing: 8) {
      Text("\(Fmt.day(batch.started).capitalized) \(Fmt.clock(batch.started))")
        .font(Theme.sans(11, .semibold)).foregroundStyle(Theme.faint)
      Spacer()
      if batch.count("running") > 0 {
        BrailleSpinner(size: 9)
      } else if batch.count("fail") > 0 {
        Text("\(batch.count("fail")) failed").font(Theme.sans(11, .medium)).foregroundStyle(Theme.fail.opacity(0.85))
      }
    }
    .padding(.horizontal, 10)
    .padding(.top, 10)
    .padding(.bottom, 5)
  }
}

private struct RunRow: View {
  let run: RunListEntry
  let selected: Bool
  @State private var hovering = false

  var body: some View {
    let tone = Tone(run.outcome)
    HStack(alignment: .center, spacing: 11) {
      Group {
        if run.outcome == "running" {
          BrailleSpinner(size: 11)
        } else {
          Circle().fill(tone.color).frame(width: 7, height: 7)
        }
      }
      .frame(width: 12)
      VStack(alignment: .leading, spacing: 2) {
        Text(run.experiment)
          .font(Theme.sans(13, selected ? .semibold : .medium))
          .foregroundStyle(Theme.text.opacity(selected ? 1 : 0.88))
          .lineLimit(1)
        if let progress = run.running {
          HStack(spacing: 8) {
            Meter(value: progress.total == 0 ? 0 : Double(progress.done) / Double(progress.total), color: Theme.aqua, height: 3)
              .frame(width: 90)
            Text("\(progress.done)/\(progress.total)").font(Theme.sans(11)).monospacedDigit().foregroundStyle(Theme.aqua)
          }
          .padding(.top, 2)
        } else if !run.brokenRules.isEmpty {
          Text(run.brokenRules.joined(separator: ", ")).font(Theme.mono(10.5)).foregroundStyle(tone.color.opacity(0.75)).lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      Text(Fmt.ago(run.started)).font(Theme.sans(11)).foregroundStyle(Theme.faint)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(selected ? Color.white.opacity(0.09) : hovering ? Color.white.opacity(0.04) : .clear)
    }
    .contentShape(Rectangle())
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
    .padding(.horizontal, 11)
    .frame(height: 30)
    .background(Capsule().fill(Color.black.opacity(0.18)))
    .overlay(Capsule().strokeBorder(focused ? Theme.accent.opacity(0.45) : Theme.line, lineWidth: 1))
    .animation(Theme.snappy, value: focused)
  }
}

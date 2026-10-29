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
        .padding(.horizontal, 8)
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
      Text("\(Fmt.day(batch.started).capitalized), \(Fmt.clock(batch.started))")
        .font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.faint)
      Spacer()
      if batch.count("running") > 0 { BrailleSpinner(size: 9) }
    }
    .padding(.horizontal, 10)
    .padding(.top, 14)
    .padding(.bottom, 4)
  }
}

private struct RunRow: View {
  let run: RunListEntry
  let selected: Bool
  @State private var hovering = false

  var body: some View {
    let tone = Tone(run.outcome)
    HStack(spacing: 10) {
      Group {
        if run.outcome == "running" {
          BrailleSpinner(size: 10)
        } else {
          Circle().fill(tone.color).frame(width: 6, height: 6)
        }
      }
      .frame(width: 10)
      Text(run.experiment)
        .font(Theme.sans(13, selected ? .medium : .regular))
        .foregroundStyle(selected ? Theme.text : tone == .fail ? Theme.text.opacity(0.92) : Theme.dim)
        .lineLimit(1)
      Spacer(minLength: 6)
      if let progress = run.running {
        Text("\(progress.done)/\(progress.total)").font(Theme.sans(11.5)).monospacedDigit().foregroundStyle(Theme.accent)
      } else {
        Text(Fmt.ago(run.started)).font(Theme.sans(11.5)).monospacedDigit().foregroundStyle(Theme.ghost)
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background {
      RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
        .fill(selected ? Theme.selection : hovering ? Theme.hover : .clear)
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help(run.brokenRules.isEmpty ? Tone.word(run.outcome) : "Broke \(run.brokenRules.joined(separator: ", "))")
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
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(focused ? Theme.fill : Color.white.opacity(0.035)))
    .animation(Theme.snappy, value: focused)
  }
}

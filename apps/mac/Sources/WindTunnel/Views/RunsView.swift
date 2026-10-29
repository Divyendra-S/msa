import SwiftUI

struct RunsSplit: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 0) {
      RunsList().frame(width: 330)
      Rectangle().fill(Theme.line).frame(width: 1)
      Group {
        if let id = model.selectedRun ?? defaultRun {
          RunDetailView(runID: id).id(id)
        } else {
          EmptyState(title: "No runs yet", text: "Runs show up here as soon as they start: from Run all, from your agent (windtunnel_run), or from a hunt.")
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
}

struct RunsList: View {
  @Environment(AppModel.self) private var model
  @State private var filter: RunFilter = .all
  @State private var query = ""
  @Namespace private var tabs

  var body: some View {
    VStack(spacing: 0) {
      VStack(spacing: 10) {
        HStack(spacing: 0) {
          ForEach(RunFilter.allCases, id: \.self) { f in
            Button {
              withAnimation(Theme.spring) { filter = f }
            } label: {
              VStack(spacing: 5) {
                HStack(spacing: 4) {
                  Text(f.rawValue).font(Theme.mono(11, filter == f ? .semibold : .regular))
                  Text("\(count(f))").font(Theme.mono(9.5)).foregroundStyle(Theme.faint)
                }
                .foregroundStyle(filter == f ? Theme.text : Theme.dim)
                ZStack {
                  if filter == f {
                    Rectangle().fill(color(f)).frame(height: 2).matchedGeometryEffect(id: "tab", in: tabs)
                  } else {
                    Rectangle().fill(.clear).frame(height: 2)
                  }
                }
              }
              .frame(maxWidth: .infinity)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
          }
        }
        SearchField(text: $query, prompt: "filter by experiment or rule")
      }
      .padding(.horizontal, 14)
      .padding(.top, 14)
      .padding(.bottom, 8)

      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
          ForEach(filtered) { batch in
            Section {
              ForEach(batch.runs) { run in
                RunRow(run: run, selected: model.selectedRun == run.id)
                  // Rows in a pinned lazy section can keep an old rendering: rebuild one when its run moves on.
                  .id("\(run.id)·\(run.outcome)·\(run.running?.done ?? -1)")
                  .onTapGesture { withAnimation(Theme.snappy) { model.selectedRun = run.id } }
              }
            } header: {
              BatchHeader(batch: batch)
            }
          }
        }
        .padding(.bottom, 20)
      }
      .scrollIndicators(.automatic)
    }
    .background(Theme.bg)
  }

  private var filtered: [Batch] {
    let q = query.lowercased()
    return model.batches.compactMap { batch in
      var b = batch
      b.runs = batch.runs.filter { r in
        (filter == .all || r.outcome == filter.rawValue)
          && (q.isEmpty || r.experiment.lowercased().contains(q) || (r.headline ?? "").lowercased().contains(q))
      }
      return b.runs.isEmpty ? nil : b
    }
  }

  private func count(_ f: RunFilter) -> Int { f == .all ? model.runs.count : model.runs.filter { $0.outcome == f.rawValue }.count }

  private func color(_ f: RunFilter) -> Color {
    switch f {
    case .all: Theme.accent
    case .fail: Theme.fail
    case .flaky: Theme.flaky
    case .pass: Theme.pass
    }
  }
}

private struct BatchHeader: View {
  let batch: Batch

  var body: some View {
    HStack(spacing: 8) {
      Text("\(Fmt.day(batch.started)) \(Fmt.clock(batch.started))").font(Theme.mono(9.5, .medium)).foregroundStyle(Theme.faint)
      Rectangle().fill(Theme.line).frame(height: 1)
      HStack(spacing: 6) {
        if batch.count("fail") > 0 { Text("✗\(batch.count("fail"))").foregroundStyle(Theme.fail) }
        if batch.count("flaky") > 0 { Text("▲\(batch.count("flaky"))").foregroundStyle(Theme.flaky) }
        if batch.count("pass") > 0 { Text("●\(batch.count("pass"))").foregroundStyle(Theme.pass.opacity(0.8)) }
        if batch.count("running") > 0 { Text("○\(batch.count("running"))").foregroundStyle(Theme.accent) }
      }
      .font(Theme.mono(9.5))
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 6)
    .background(Theme.bg.opacity(0.96))
  }
}

private struct RunRow: View {
  let run: RunListEntry
  let selected: Bool
  @State private var hovering = false

  var body: some View {
    let tone = Tone(run.outcome)
    HStack(alignment: .top, spacing: 10) {
      Group {
        if run.outcome == "running" { BrailleSpinner(size: 12) } else { Text(tone.glyph).font(Theme.mono(12, .bold)).foregroundStyle(tone.color) }
      }
      .frame(width: 14, alignment: .center)
      .padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        Text(run.experiment)
          .font(Theme.mono(12, selected ? .semibold : .medium))
          .foregroundStyle(selected ? Theme.text : Theme.text.opacity(0.88))
          .lineLimit(1)
        if let progress = run.running {
          HStack(spacing: 6) {
            AsciiBar(value: progress.total == 0 ? 0 : Double(progress.done) / Double(progress.total), width: 12, font: Theme.mono(8))
            Text("\(progress.done)/\(progress.total)").font(Theme.mono(10)).foregroundStyle(Theme.accent)
          }
        } else {
          Text(subtitle).font(Theme.mono(10.5)).foregroundStyle(run.outcome == "pass" ? Theme.faint : tone.color.opacity(0.85)).lineLimit(1)
        }
      }
      Spacer(minLength: 4)
      Text(Fmt.ago(run.started)).font(Theme.mono(9.5)).foregroundStyle(Theme.faint)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background {
      if selected {
        Theme.raised.overlay(alignment: .leading) { Rectangle().fill(tone.color).frame(width: 2) }
      } else if hovering {
        Theme.surface
      }
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
  }

  private var subtitle: String {
    if !run.brokenRules.isEmpty { return run.brokenRules.joined(separator: " · ") }
    if let h = run.headline, h != run.outcome { return h }
    return run.outcome == "pass" ? "every rule held" : run.outcome
  }
}

struct SearchField: View {
  @Binding var text: String
  var prompt: String
  @FocusState private var focused: Bool

  var body: some View {
    HStack(spacing: 7) {
      Text("/").font(Theme.mono(11, .bold)).foregroundStyle(focused ? Theme.accent : Theme.faint)
      TextField("", text: $text, prompt: Text(prompt).foregroundStyle(Theme.faint))
        .textFieldStyle(.plain)
        .font(Theme.mono(11.5))
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
    .background(RoundedRectangle(cornerRadius: 6).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(focused ? Theme.accent.opacity(0.5) : Theme.line))
    .animation(Theme.snappy, value: focused)
  }
}

struct EmptyState: View {
  let title: String
  let text: String

  var body: some View {
    ZStack {
      AirflowField(fontSize: 10, color: Theme.accent.opacity(0.5), obstacle: false)
        .mask(RadialGradient(colors: [.black, .clear], center: .center, startRadius: 40, endRadius: 380))
      VStack(spacing: 10) {
        Text(title).font(Theme.mono(15, .semibold)).foregroundStyle(Theme.text)
        Text(text).font(Theme.sans(12.5)).foregroundStyle(Theme.dim).multilineTextAlignment(.center).frame(maxWidth: 380)
      }
      .padding(24)
      .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg.opacity(0.9)))
    }
  }
}

import SwiftUI

struct ExperimentsSplit: View {
  @Environment(AppModel.self) private var model
  @State private var query = ""

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        SearchField(text: $query, prompt: "Filter").padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 10)
        Hairline()
        if let error = model.experimentsError {
          Text(error).font(Theme.sans(12)).foregroundStyle(Theme.fail).padding(.horizontal, 14).padding(.bottom, 8)
        }
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(filtered) { e in
              ExperimentRow(experiment: e, latest: model.latestByExperiment[e.id], selected: selectedID == e.id)
                .onTapGesture { withAnimation(Theme.snappy) { model.selectedExperiment = e.id } }
            }
          }
          .padding(.horizontal, 8)
          .padding(.vertical, 8)
        }
        .scrollIndicators(.never)
      }
      .frame(width: 292)
      Hairline(vertical: true)
      Group {
        if let e = model.experiments.first(where: { $0.id == selectedID }) {
          ExperimentDetail(experiment: e).id(e.id)
        } else {
          EmptyState(title: "No experiments yet", text: "Your agent writes them during /windtunnel:init and hunts.")
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  private var selectedID: String? { model.selectedExperiment ?? model.experiments.first?.id }

  private var filtered: [ExperimentEntry] {
    let q = query.lowercased()
    return model.experiments.filter { q.isEmpty || $0.id.contains(q) || ($0.description ?? "").lowercased().contains(q) }
  }
}

private struct ExperimentRow: View {
  let experiment: ExperimentEntry
  let latest: RunListEntry?
  let selected: Bool
  @State private var hovering = false

  var body: some View {
    let outcome = latest?.outcome ?? experiment.last?.outcome
    let tone = Tone(outcome)
    HStack(spacing: 10) {
      Group {
        if outcome == "running" {
          BrailleSpinner(size: 10)
        } else if outcome == nil {
          Circle().strokeBorder(Theme.ghost, lineWidth: 1).frame(width: 6, height: 6)
        } else {
          Circle().fill(tone.color).frame(width: 6, height: 6)
        }
      }
      .frame(width: 10)
      Text(experiment.id)
        .font(Theme.sans(13, selected ? .medium : .regular))
        .foregroundStyle(selected ? Theme.text : tone == .fail ? Theme.text.opacity(0.92) : Theme.dim)
        .lineLimit(1)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background {
      RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
        .fill(selected ? Theme.selection : hovering ? Theme.hover : .clear)
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .help(experiment.description ?? experiment.id)
  }
}

struct ExperimentDetail: View {
  @Environment(AppModel.self) private var model
  let experiment: ExperimentEntry
  @State private var source = ""
  @State private var repeatCount = 0

  var body: some View {
    let history = model.runs.filter { $0.experiment == experiment.id }
    let job = model.jobs.first { $0.status == "running" && ($0.experiments.isEmpty || $0.experiments.contains(experiment.id)) }
      ?? model.jobs.first { $0.experiments == [experiment.id] }
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .center, spacing: 8) {
            Text(experiment.id).font(Theme.sans(22, .semibold)).tracking(-0.2).foregroundStyle(Theme.text).lineLimit(1)
              .minimumScaleFactor(0.8).layoutPriority(1)
            Spacer(minLength: 12)
            Button("Open File") { model.openFile(experiment.file) }
              .buttonStyle(ActionButtonStyle())
            Button {
              model.runExperiments([experiment.id], repeat: repeatCount > 0 ? repeatCount : nil)
            } label: {
              Label(job?.status == "running" ? "Running…" : "Run", systemImage: "play.fill")
            }
            .buttonStyle(ActionButtonStyle(prominent: true))
            .disabled(model.runningJob != nil)
          }
          HStack(spacing: 10) {
            if let latest = history.first { OutcomeBadge(outcome: latest.outcome) }
            Text(meta).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1)
          }
          .padding(.top, 6)
          if let d = experiment.description {
            Text(d).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).frame(maxWidth: 680, alignment: .leading).padding(.top, 14)
          }
        }
        .rise()

        if let job {
          JobPanel(job: job)
        }

        Panel("History", accessory: {
          HStack(spacing: 8) {
            Text("Repeat")
            Stepper(value: $repeatCount, in: 0...50) {
              Text(repeatCount == 0 ? "default" : "\(repeatCount)×").font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.dim).frame(width: 46, alignment: .trailing)
            }
            .controlSize(.mini)
            .help("How many times Run repeats it")
          }
        }) {
          if history.isEmpty {
            Text("Never run.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
          } else {
            VStack(alignment: .leading, spacing: 14) {
              HStack(spacing: 3) {
                ForEach(history.prefix(48).reversed()) { run in
                  RoundedRectangle(cornerRadius: 1)
                    .fill(run.outcome == "pass" ? Theme.accent.opacity(0.6) : Tone(run.outcome).color)
                    .frame(width: 6, height: 14)
                    .help("\(Tone.word(run.outcome)) · \(Fmt.ago(run.started))")
                    .onTapGesture {
                      model.selectedRun = run.id
                      model.section = .runs
                    }
                }
              }
              VStack(spacing: 0) {
                ForEach(history.prefix(5)) { run in
                  HistoryRow(run: run)
                }
              }
              .padding(.horizontal, -10)
            }
          }
        }

        Panel("Source", accessory: { Text((experiment.file as NSString).lastPathComponent).font(Theme.mono(11)) }) {
          Text(YAML.highlight(source)).font(Theme.mono(12)).textSelection(.enabled).lineSpacing(4)
            .well(padding: 16)
        }
      }
      .padding(.horizontal, Theme.gutter)
      .padding(.top, 10)
      .padding(.bottom, 32)
      .frame(maxWidth: Theme.measure, alignment: .leading)
    }
    .task(id: experiment.id) {
      source = (try? String(contentsOfFile: experiment.file, encoding: .utf8)) ?? "(couldn't read \(experiment.file))"
    }
  }

  private var meta: String {
    var parts: [String] = []
    if let flow = experiment.flow { parts.append("Flow \(flow)") }
    if let users = experiment.users, !users.isEmpty { parts.append("as \(users.joined(separator: ", "))") }
    if let n = experiment.repeatCount { parts.append("repeats \(n)×") }
    if let p = experiment.perturb, p > 0 { parts.append(Fmt.plural(p, "perturbation")) }
    return parts.joined(separator: "  ·  ")
  }
}

private struct HistoryRow: View {
  @Environment(AppModel.self) private var model
  let run: RunListEntry
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 12) {
      Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6)
      Text(run.brokenRules.isEmpty ? (run.outcome == "pass" ? "Every rule held" : Tone.word(run.outcome)) : "Broke \(run.brokenRules.joined(separator: ", "))")
        .font(Theme.sans(13))
        .foregroundStyle(Theme.dim).lineLimit(1)
      Spacer()
      Text(Fmt.ago(run.started)).font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.ghost)
    }
    .padding(.horizontal, 10)
    .frame(height: 32)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture {
      model.selectedRun = run.id
      model.section = .runs
    }
  }
}

/// A run started from the app: its CLI output, live.
struct JobPanel: View {
  let job: RunJob

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let error = job.error {
        Text(error).font(Theme.sans(12)).foregroundStyle(Theme.fail)
      }
      TerminalPanel(title: job.status == "running" ? "Running" : Tone.word(job.status), lines: job.output, tint: job.status == "running" || Tone(job.status) == .pass ? nil : Tone(job.status).color, follow: true)
    }
    .rise()
  }
}

enum YAML {
  static func highlight(_ text: String) -> AttributedString {
    var out = AttributedString()
    for (i, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
      if i > 0 { out += AttributedString("\n") }
      let s = String(line)
      if s.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
        var a = AttributedString(s)
        a.foregroundColor = Theme.faint
        out += a
        continue
      }
      if let colon = s.firstIndex(of: ":"), !s[..<colon].contains(" ") || s.trimmingCharacters(in: .whitespaces).hasPrefix("- ") {
        var key = AttributedString(String(s[...colon]))
        key.foregroundColor = Theme.accent
        var value = AttributedString(String(s[s.index(after: colon)...]))
        value.foregroundColor = Theme.text.opacity(0.9)
        out += key
        out += value
      } else {
        var a = AttributedString(s)
        a.foregroundColor = Theme.dim
        out += a
      }
    }
    return out
  }
}

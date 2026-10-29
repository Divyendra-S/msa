import SwiftUI

struct ExperimentsSplit: View {
  @Environment(AppModel.self) private var model
  @State private var query = ""

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        SearchField(text: $query, prompt: "Filter experiments").padding(12)
        if let error = model.experimentsError {
          Text(error).font(Theme.sans(12)).foregroundStyle(Theme.fail).padding(.horizontal, 14).padding(.bottom, 8)
        }
        ScrollView {
          LazyVStack(spacing: 1) {
            ForEach(filtered) { e in
              ExperimentRow(experiment: e, latest: model.latestByExperiment[e.id], selected: selectedID == e.id)
                .onTapGesture { withAnimation(Theme.snappy) { model.selectedExperiment = e.id } }
            }
          }
          .padding(.horizontal, 6)
          .padding(.bottom, 12)
        }
        .scrollIndicators(.never)
      }
      .frame(width: 304)
      .card(radius: 18)
      .padding(.bottom, 8)
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
    HStack(alignment: .top, spacing: 11) {
      Group {
        if outcome == "running" {
          BrailleSpinner(size: 11)
        } else if outcome == nil {
          Circle().strokeBorder(Theme.faint, lineWidth: 1.2).frame(width: 7, height: 7)
        } else {
          Circle().fill(Tone(outcome).color).frame(width: 7, height: 7)
        }
      }
      .frame(width: 12, height: 16)
      VStack(alignment: .leading, spacing: 2) {
        Text(experiment.id).font(Theme.sans(13, selected ? .semibold : .medium)).foregroundStyle(Theme.text.opacity(selected ? 1 : 0.88)).lineLimit(1)
        if let d = experiment.description {
          Text(d).font(Theme.sans(11.5)).foregroundStyle(Theme.faint).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
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
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 8) {
          HStack(alignment: .center, spacing: 12) {
            Text(experiment.id).font(Theme.sans(22, .semibold)).tracking(-0.3).foregroundStyle(Theme.text).lineLimit(1)
              .minimumScaleFactor(0.8).layoutPriority(1)
            if let latest = history.first { OutcomeBadge(outcome: latest.outcome, large: true) }
            Spacer(minLength: 12)
            Button {
              model.openFile(experiment.file)
            } label: {
              Image(systemName: "doc.text")
            }
            .buttonStyle(GlassButtonStyle())
            .help("Open the file")
            Button {
              model.runExperiments([experiment.id], repeat: repeatCount > 0 ? repeatCount : nil)
            } label: {
              Label(job?.status == "running" ? "Running…" : "Run", systemImage: "play.fill")
            }
            .buttonStyle(GlassButtonStyle(prominent: true))
            .disabled(model.runningJob != nil)
          }
          Text(meta).font(Theme.sans(12)).foregroundStyle(Theme.faint)
          if let d = experiment.description {
            Text(d).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(2).frame(maxWidth: 720, alignment: .leading).padding(.top, 2)
          }
        }
        .rise()

        if let job {
          JobPanel(job: job)
        }

        Panel("History", accessory: {
          HStack(spacing: 10) {
            Text("Repeat")
            Stepper(value: $repeatCount, in: 0...50) {
              Text(repeatCount == 0 ? "default" : "\(repeatCount)×").font(Theme.sans(11.5, .medium)).monospacedDigit().foregroundStyle(Theme.dim).frame(width: 46, alignment: .trailing)
            }
            .controlSize(.mini)
            .help("How many times Run repeats it")
          }
        }) {
          if history.isEmpty {
            Text("Never run.").font(Theme.sans(12.5)).foregroundStyle(Theme.dim)
          } else {
            VStack(alignment: .leading, spacing: 12) {
              HStack(spacing: 4) {
                ForEach(history.prefix(40).reversed()) { run in
                  Circle()
                    .fill(Tone(run.outcome).color.gradient)
                    .frame(width: 9, height: 9)
                    .padding(2)
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
              .padding(.horizontal, -8)
            }
          }
        }

        Panel("Source", accessory: { Text((experiment.file as NSString).lastPathComponent).font(Theme.mono(10.5)) }) {
          Text(YAML.highlight(source)).font(Theme.mono(11.5)).textSelection(.enabled).lineSpacing(2)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.well))
        }
      }
      .padding(.horizontal, 26)
      .padding(.top, 8)
      .padding(.bottom, 28)
      .frame(maxWidth: 1100, alignment: .leading)
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
    HStack(spacing: 11) {
      Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6)
      Text(run.brokenRules.isEmpty ? (run.outcome == "pass" ? "Every rule held" : Tone.word(run.outcome)) : run.brokenRules.joined(separator: ", "))
        .font(run.brokenRules.isEmpty ? Theme.sans(12.5) : Theme.mono(11.5))
        .foregroundStyle(Theme.dim).lineLimit(1)
      Spacer()
      Text(Fmt.ago(run.started)).font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
      Image(systemName: "chevron.right").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(hovering ? Theme.dim : Theme.ghost)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 7)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(hovering ? Color.white.opacity(0.05) : .clear))
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
        Text(error).font(Theme.sans(12.5)).foregroundStyle(Theme.fail)
      }
      TerminalPanel(title: job.status == "running" ? "Running" : Tone.word(job.status), lines: job.output, tint: job.status == "running" ? nil : Tone(job.status).color, follow: true)
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

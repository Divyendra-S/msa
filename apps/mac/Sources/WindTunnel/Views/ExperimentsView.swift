import SwiftUI

struct ExperimentsSplit: View {
  @Environment(AppModel.self) private var model
  @State private var query = ""

  var body: some View {
    HStack(spacing: 0) {
      VStack(spacing: 0) {
        VStack(spacing: 10) {
          HStack {
            Text("experiments").label()
            Spacer()
            Text("\(model.experiments.count)").font(Theme.mono(10)).foregroundStyle(Theme.faint)
          }
          SearchField(text: $query, prompt: "filter")
        }
        .padding(14)
        if let error = model.experimentsError {
          Text(error).font(Theme.mono(11)).foregroundStyle(Theme.fail).padding(14)
        }
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(filtered) { e in
              ExperimentRow(experiment: e, latest: model.latestByExperiment[e.id], selected: selectedID == e.id)
                .onTapGesture { withAnimation(Theme.snappy) { model.selectedExperiment = e.id } }
            }
          }
        }
      }
      .frame(width: 330)
      Rectangle().fill(Theme.line).frame(width: 1)
      Group {
        if let e = model.experiments.first(where: { $0.id == selectedID }) {
          ExperimentDetail(experiment: e).id(e.id)
        } else {
          EmptyState(title: "No experiments yet", text: "The agent writes them in .windtunnel/experiments/ during /windtunnel:init and hunts. Start a hunt to get some.")
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
    HStack(alignment: .top, spacing: 10) {
      Group {
        if outcome == "running" { BrailleSpinner(size: 12) } else { Text(outcome == nil ? "○" : tone.glyph).foregroundStyle(tone.color) }
      }
      .font(Theme.mono(12, .bold))
      .frame(width: 14)
      VStack(alignment: .leading, spacing: 3) {
        Text(experiment.id).font(Theme.mono(12, selected ? .semibold : .medium)).foregroundStyle(Theme.text).lineLimit(1)
        Text(experiment.description ?? "").font(Theme.sans(11)).foregroundStyle(Theme.faint).lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .background {
      if selected {
        Theme.raised.overlay(alignment: .leading) { Rectangle().fill(Theme.accent).frame(width: 2) }
      } else if hovering {
        Theme.surface
      }
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
        VStack(alignment: .leading, spacing: 10) {
          Text("experiment").label()
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            ScrambleText(text: experiment.id, font: Theme.mono(24, .bold))
            if let latest = history.first { OutcomeBadge(outcome: latest.outcome, large: true) }
            Spacer()
          }
          if let d = experiment.description {
            Text(d).font(Theme.sans(13.5)).foregroundStyle(Theme.dim).frame(maxWidth: 760, alignment: .leading)
          }
          HStack(spacing: 6) {
            if let flow = experiment.flow { Chip(text: "flow \(flow)") }
            if let users = experiment.users, !users.isEmpty { Chip(text: "as \(users.joined(separator: ", "))") }
            if let n = experiment.repeatCount { Chip(text: "repeat \(n)") }
            if let p = experiment.perturb, p > 0 { Chip(text: "\(p) perturbation\(p == 1 ? "" : "s")", color: Theme.flaky) }
          }
          Text(Fmt.tilde(experiment.file)).font(Theme.mono(10.5)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.head)
            .onTapGesture { model.reveal(experiment.file) }.help("Show in Finder")
        }
        .rise()

        HStack(spacing: 12) {
          Button {
            model.runExperiments([experiment.id], repeat: repeatCount > 0 ? repeatCount : nil)
          } label: {
            Label(job?.status == "running" ? "Running…" : "Run", systemImage: "play.fill")
          }
          .buttonStyle(TermButtonStyle(prominent: true))
          .disabled(model.runningJob != nil)
          HStack(spacing: 6) {
            Text("repeat").font(Theme.mono(11)).foregroundStyle(Theme.faint)
            Stepper(value: $repeatCount, in: 0...50) {
              Text(repeatCount == 0 ? "default" : "\(repeatCount)×").font(Theme.mono(11.5)).foregroundStyle(Theme.text).frame(width: 56, alignment: .leading)
            }
            .controlSize(.small)
          }
          Button("Open file") { model.openFile(experiment.file) }.buttonStyle(TermButtonStyle())
          Spacer()
        }

        if let job {
          JobPanel(job: job)
        }

        Panel("history", accessory: {
          Text(Fmt.plural(history.count, "run")).font(Theme.mono(10)).foregroundStyle(Theme.faint)
        }) {
          if history.isEmpty {
            Text("Never run. Press Run.").font(Theme.mono(11.5)).foregroundStyle(Theme.dim)
          } else {
            VStack(alignment: .leading, spacing: 10) {
              HStack(spacing: 3) {
                ForEach(history.prefix(40).reversed()) { run in
                  Text(Tone(run.outcome).glyph)
                    .font(Theme.mono(13, .bold))
                    .foregroundStyle(Tone(run.outcome).color)
                    .frame(width: 16)
                    .help("\(run.outcome) · \(Fmt.ago(run.started))")
                    .onTapGesture {
                      model.selectedRun = run.id
                      model.section = .runs
                    }
                }
              }
              ForEach(history.prefix(6)) { run in
                HStack(spacing: 10) {
                  Text(Tone(run.outcome).glyph).foregroundStyle(Tone(run.outcome).color)
                  Text(run.headline.flatMap { $0 == run.outcome ? nil : $0 } ?? (run.outcome == "pass" ? "every rule held" : run.outcome)).foregroundStyle(Theme.dim).lineLimit(1)
                  Text(run.id).foregroundStyle(Theme.ghost)
                  Spacer()
                  Text(Fmt.ago(run.started)).foregroundStyle(Theme.faint)
                }
                .font(Theme.mono(11))
                .contentShape(Rectangle())
                .onTapGesture {
                  model.selectedRun = run.id
                  model.section = .runs
                }
              }
            }
          }
        }

        Panel("source", accessory: {
          Text((experiment.file as NSString).lastPathComponent).font(Theme.mono(10)).foregroundStyle(Theme.faint)
        }) {
          Text(YAML.highlight(source)).font(Theme.mono(11.5)).textSelection(.enabled).lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(24)
      .frame(maxWidth: 1100, alignment: .leading)
    }
    .task(id: experiment.id) {
      source = (try? String(contentsOfFile: experiment.file, encoding: .utf8)) ?? "(couldn't read \(experiment.file))"
    }
  }
}

/// A run started from the app: its CLI output, live.
struct JobPanel: View {
  @Environment(AppModel.self) private var model
  let job: RunJob

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        if job.status == "running" { BrailleSpinner() } else { Text(Tone(job.status).glyph).foregroundStyle(Tone(job.status).color) }
        Text("windtunnel run \(job.experiments.joined(separator: " "))\(job.repeatCount.map { " --repeat \($0)" } ?? "")")
          .font(Theme.mono(11.5)).foregroundStyle(Theme.text)
        Spacer()
        Text(job.status).font(Theme.mono(10.5)).foregroundStyle(Tone(job.status).color)
        if job.status == "running" {
          Button("stop") { model.stopJob(job.id) }.buttonStyle(.plain).font(Theme.mono(11)).foregroundStyle(Theme.fail)
        }
      }
      if let error = job.error { Text(error).font(Theme.mono(11)).foregroundStyle(Theme.fail) }
      TerminalPanel(title: "output", lines: job.output, follow: true)
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

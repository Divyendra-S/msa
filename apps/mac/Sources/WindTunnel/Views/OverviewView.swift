import SwiftUI

/// Which of the app's flows break, under what, and what to do about it. The verdict and the
/// working tree's check against HEAD; then each flow with its steps and a card per experiment on
/// it; then what went wrong, each with its picture, its cause and a prompt for the fix.
struct OverviewView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      if model.experiments.isEmpty && model.runs.isEmpty {
        FirstRun(stage: .noExperiments)
      } else if model.runs.isEmpty {
        FirstRun(stage: .neverRun)
      } else if let replay = model.replay {
        let flows = FlowGroup.group(replay.experiments)
        ScrollViewReader { scroller in
          ScrollView {
            VStack(alignment: .leading, spacing: 40) {
              VerdictHeader(flows: flows).rise()
              FlowsBoard(flows: flows).rise(0.05).id("flows")
              WhatWentWrong(experiments: replay.experiments).rise(0.1).id("wrong")
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.top, 4)
            .padding(.bottom, 40)
            .frame(maxWidth: Theme.measure + 160, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .scrollIndicators(.never)
          // `--scroll wrong`: opens at what went wrong.
          .task {
            guard let to = Launch.value("--scroll") else { return }
            try? await Task.sleep(for: .milliseconds(400))
            scroller.scrollTo(to, anchor: .top)
          }
        }
      } else if let error = model.replayError {
        EmptyState(title: "Couldn't load the runs", text: error)
      } else {
        VStack(spacing: 14) {
          DitherBar(width: 96)
          Text("Lining up the flows").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task { await model.loadReplay() }
  }
}

// MARK: - Verdict

/// How many flows break, the experiments by how they went, and beside it the change's check.
private struct VerdictHeader: View {
  @Environment(AppModel.self) private var model
  let flows: [FlowGroup]

  var body: some View {
    let all = flows.flatMap(\.experiments)
    let verdicts = all.map { TestVerdict($0) }
    let breaking = flows.filter(\.breaks).count
    HStack(alignment: .top, spacing: 32) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("\(breaking == 0 ? flows.count : breaking)")
            .font(Theme.figure(56))
            .foregroundStyle(breaking == 0 ? Theme.text : Theme.fail)
            .contentTransition(.numericText(value: Double(breaking)))
          Text(breaking == 0 ? (flows.count == 1 ? "flow, and it holds" : "flows, every one holding") : "of \(Fmt.plural(flows.count, "flow")) \(breaking == 1 ? "breaks" : "break")")
            .font(Theme.sans(15)).foregroundStyle(Theme.faint)
        }
        HStack(spacing: 18) {
          Counter(n: verdicts.filter { $0.kind == .breaks }.count, word: "break", color: Theme.fail)
          Counter(n: verdicts.filter { $0.kind == .crashes }.count, word: "crash", color: Theme.fail)
          Counter(n: verdicts.filter { $0.kind == .stops }.count, word: "can't finish", color: Theme.flaky)
          Counter(n: verdicts.filter { $0.kind == .holds }.count, word: "hold", color: Theme.accent)
          Counter(n: verdicts.filter { $0.kind == .notRun }.count, word: "not run", color: Theme.ghost)
        }
        .padding(.top, 16)
        Text(lastRun).font(Theme.sans(12)).foregroundStyle(Theme.ghost).padding(.top, 12)
      }
      .layoutPriority(1)
      Spacer(minLength: 0)
      CheckCard().frame(width: 340)
    }
  }

  private var lastRun: String {
    let runs = model.replay?.experiments.compactMap { $0.run } ?? []
    let reps = runs.reduce(0) { $0 + $1.reps }
    let newest = runs.compactMap { ISO.date($0.startedAt) }.max()
    return "\(Fmt.plural(runs.count, "test")), \(Fmt.plural(reps, "run")) on their newest results · last \(Fmt.ago(newest))"
  }

  private struct Counter: View {
    let n: Int
    let word: String
    let color: Color

    var body: some View {
      if n > 0 {
        HStack(spacing: 6) {
          Circle().fill(color).frame(width: 7, height: 7)
          Text("\(n)").font(Theme.sans(13, .semibold)).monospacedDigit().foregroundStyle(Theme.text)
          Text(word).font(Theme.sans(13)).foregroundStyle(Theme.dim)
        }
      }
    }
  }
}

/// The working tree against HEAD: what the change broke, what was broken already, what it fixed.
private struct CheckCard: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius + 2, style: .continuous)
    let job = model.runningJob
    let regressed = (model.check?.counts.regressed ?? 0) > 0 && job?.isCheck != true
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 7) {
        Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.dim)
        Text("Your changes").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
        Spacer(minLength: 6)
        if let c = model.check, job?.isCheck != true {
          Text("vs \(c.base.label) · \(Fmt.ago(c.date))").font(Theme.sans(11)).foregroundStyle(Theme.faint).lineLimit(1)
        }
      }
      if let job, job.isCheck {
        HStack(spacing: 8) {
          BrailleSpinner(size: 10)
          Text(progress(job)).font(Theme.sans(12)).foregroundStyle(Theme.dim).lineLimit(2)
        }
        Button("Stop") { model.stopJob(job.id) }.buttonStyle(LinkButtonStyle(color: Theme.fail))
      } else if let c = model.check {
        Text(headline(c))
          .font(Theme.sans(19, .semibold)).tracking(-0.3)
          .foregroundStyle(c.counts.regressed > 0 ? Theme.fail : Theme.text)
        let notable = c.entries.filter { $0.verdict != "holds" }
        if !notable.isEmpty {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(notable.prefix(4)) { CheckRow(entry: $0, base: c.base.label) }
          }
          .padding(.horizontal, -6)
        }
        if notable.count > 4 {
          Text("and \(notable.count - 4) more").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
        }
        Button {
          model.checkChanges()
        } label: {
          Label("Check again", systemImage: "arrow.clockwise")
        }
        .buttonStyle(ActionButtonStyle())
        .disabled(job != nil)
      } else {
        Text("Did your change break anything? Every test runs on your working tree, and what fails runs again on HEAD.")
          .font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
        Button {
          model.checkChanges()
        } label: {
          Label("Check changes", systemImage: "checkmark.shield")
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
        .disabled(job != nil)
      }
    }
    .padding(16)
    .background(shape.fill(Theme.overlay(0.04)))
    .overlay(shape.strokeBorder(regressed ? Theme.fail.opacity(0.45) : Theme.line, lineWidth: 1))
    .help("windtunnel check: the experiments on your working tree, and those that don't hold, on HEAD too. Exit 2 on a regression, for an agent to run before a pull request.")
  }

  private func headline(_ c: Check) -> String {
    if c.counts.regressed > 0 { return "\(Fmt.plural(c.counts.regressed, "regression"))" }
    if c.same { return "No changes to check" }
    return "Nothing regressed"
  }

  /// The check's newest line of progress, without the indent.
  private func progress(_ job: RunJob) -> String {
    let line = job.output.last { !$0.trimmingCharacters(in: .whitespaces).isEmpty }?.trimmingCharacters(in: .whitespaces)
    return line.map { $0.capitalizedFirst } ?? "Checking against \(job.base ?? "HEAD")"
  }
}

private struct CheckRow: View {
  @Environment(AppModel.self) private var model
  let entry: Check.Entry
  let base: String
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 8) {
      Text(word).font(Theme.sans(11, .semibold)).foregroundStyle(color).frame(width: 84, alignment: .leading)
      Text(entry.experiment).font(Theme.mono(11)).foregroundStyle(hovering ? Theme.text : Theme.dim).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 4)
      Image(systemName: "play.fill").font(.system(size: 8)).foregroundStyle(Theme.faint).opacity(hovering ? 1 : 0)
    }
    .padding(.horizontal, 6)
    .frame(height: 24)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture { model.play(entry.experiment) }
    .help(help)
  }

  private var word: String {
    switch entry.verdict {
    case "regressed": "Regressed"
    case "new": "New, breaks"
    case "broken": "Already broken"
    case "fixed": "Fixed"
    default: "Holds"
    }
  }

  private var color: Color {
    switch entry.verdict {
    case "regressed": Theme.fail
    case "new", "broken": Theme.flaky
    case "fixed": Theme.accent
    default: Theme.faint
    }
  }

  private var help: String {
    let change = entry.change.broken.isEmpty ? entry.change.outcome : entry.change.broken.joined(separator: ", ")
    switch entry.verdict {
    case "regressed": return "Holds on \(base); with your change: \(change)"
    case "new": return "Breaks with your change (\(change)), and can't run on \(base)\(entry.baseError.map { ": \($0)" } ?? ", so it came with the change")"
    case "broken": return entry.base?.outcome == "error" ? "Couldn't run on \(base); with your change: \(change)" : "Broken on \(base) too: \(change)"
    case "fixed": return "Broke on \(base); holds with your change"
    default: return "Holds"
    }
  }
}

// MARK: - Flows

/// Each flow: its steps as the newest run pictured them, then a card per experiment on it.
private struct FlowsBoard: View {
  let flows: [FlowGroup]

  var body: some View {
    Panel("Flows", accessory: { Text("\(flows.count)") }) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(flows.enumerated()), id: \.element.id) { i, flow in
          FlowRow(flow: flow)
          if i < flows.count - 1 { Hairline().opacity(0.6) }
        }
      }
    }
  }
}

private struct FlowRow: View {
  @Environment(AppModel.self) private var model
  let flow: FlowGroup

  var body: some View {
    let failing = flow.experiments.filter { TestVerdict($0).failing }.count
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(flow.title).font(Theme.sans(15, .semibold)).foregroundStyle(Theme.text)
        Spacer(minLength: 8)
        Text(failing > 0 ? "\(failing) of \(flow.experiments.count) \(failing == 1 ? "breaks" : "break")" : "\(flow.experiments.count == 1 ? "holds" : "all \(flow.experiments.count) hold")")
          .font(Theme.sans(12, failing > 0 ? .medium : .regular))
          .foregroundStyle(failing > 0 ? Theme.fail : Theme.faint)
      }
      HStack(alignment: .top, spacing: 24) {
        Filmstrip(experiment: flow.reference)
          .frame(width: Filmstrip.width, alignment: .leading)
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 156, maximum: 230), spacing: 10)], alignment: .leading, spacing: 10) {
          ForEach(flow.experiments) { TestCell(experiment: $0) }
        }
      }
    }
    .padding(.vertical, 20)
  }
}

/// A flow's steps, as its run pictured them; a step opens the player there.
private struct Filmstrip: View {
  @Environment(AppModel.self) private var model
  let experiment: Replay.Experiment?
  static let shown = 3
  static let thumb = CGSize(width: 96, height: 60)
  static let width: CGFloat = CGFloat(shown) * thumb.width + CGFloat(shown - 1) * 20

  var body: some View {
    let frames = (experiment?.frames ?? []).filter { $0.lane == 0 }.sorted { $0.column < $1.column }
    if let e = experiment, !frames.isEmpty {
      HStack(alignment: .top, spacing: 0) {
        ForEach(Array(frames.prefix(Self.shown).enumerated()), id: \.offset) { i, f in
          if i > 0 {
            Image(systemName: "chevron.compact.right").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.ghost)
              .frame(width: 20, height: Self.thumb.height)
          }
          Step(frame: f, last: i == Self.shown - 1 && frames.count > Self.shown ? frames.count - Self.shown : 0) {
            withAnimation(Theme.snappy) {
              model.playRequest = PlayerRef(experiment: e.id, column: f.column)
              model.section = .replay
            }
          }
        }
      }
    } else {
      Text("Not run yet").font(Theme.sans(12)).foregroundStyle(Theme.ghost).frame(height: Self.thumb.height)
    }
  }

  private struct Step: View {
    let frame: Replay.Frame
    /// Steps after this one that aren't shown.
    let last: Int
    let open: () -> Void
    @State private var hovering = false

    var body: some View {
      let shape = RoundedRectangle(cornerRadius: 5, style: .continuous)
      VStack(alignment: .leading, spacing: 6) {
        ShotView(frame: frame, compact: true)
          .frame(width: Filmstrip.thumb.width, height: Filmstrip.thumb.height)
          .clipShape(shape)
          .overlay {
            if last > 0 {
              shape.fill(.black.opacity(0.55))
              Text("+\(last)").font(Theme.sans(13, .semibold)).foregroundStyle(.white)
            }
          }
          .overlay(shape.strokeBorder(frame.error != nil ? Theme.fail.opacity(0.8) : hovering ? Theme.lineStrong : Theme.line, lineWidth: 1))
        Text(frame.step).font(Theme.mono(10)).foregroundStyle(hovering ? Theme.text : Theme.faint)
          .lineLimit(1).truncationMode(.tail)
          .frame(width: Filmstrip.thumb.width, alignment: .leading)
      }
      .contentShape(Rectangle())
      .onHover { hovering = $0 }
      .onTapGesture(perform: open)
      .help("\(frame.step): play from here")
    }
  }
}

/// One experiment on a flow: what it does to the app, how its newest run went (live while it
/// runs), and its runs as a bar. Opens the player.
private struct TestCell: View {
  @Environment(AppModel.self) private var model
  let experiment: Replay.Experiment
  @State private var hovering = false

  var body: some View {
    let e = experiment
    let running = model.runs.first { $0.experiment == e.id && $0.outcome == "running" }
    let v = TestVerdict(e, running: running)
    let shape = RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Image(systemName: Pressure.symbol(e.pressure)).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.dim)
          .frame(width: 14)
        Text(Pressure.words(e.pressure)).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        Spacer(minLength: 4)
        Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(Theme.text).opacity(hovering && e.run != nil ? 1 : 0)
      }
      Text(e.id).font(Theme.mono(10.5)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle).padding(.top, 4)
      Spacer(minLength: 10)
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        if v.kind == .running { BrailleSpinner(size: 11) }
        Text(v.word).font(Theme.sans(15, .semibold)).foregroundStyle(v.color)
        Spacer(minLength: 4)
        Text(v.count).font(Theme.sans(11)).monospacedDigit().foregroundStyle(Theme.faint)
      }
      RunsBar(verdict: v).frame(height: 4).padding(.top, 8)
    }
    .padding(12)
    .frame(height: 108)
    .background(shape.fill(Theme.overlay(hovering ? 0.075 : 0.04)))
    .overlay(shape.strokeBorder(v.failing ? v.color.opacity(0.4) : Theme.line, lineWidth: 1))
    .contentShape(shape)
    .onHover { hovering = $0 }
    .onTapGesture { if e.run != nil { model.play(e.id) } }
    .animation(Theme.snappy, value: hovering)
    .help([e.description, Pressure.place(e.pressure).map { "At \($0)" }].compactMap { $0 }.joined(separator: "\n"))
    .contextMenu {
      if e.run != nil { Button("Play") { model.play(e.id) } }
      Button("Run Again") { model.runExperiments([e.id]) }.disabled(model.runningJob != nil)
      if v.failing {
        Button("Copy Fix Prompt") { model.copy(FixPrompt.text(e, file: model.experiments.first { $0.id == e.id }?.file, project: model.status?.project.name)) }
      }
      Button("Show in Experiments") {
        model.selectedExperiment = e.id
        model.section = .experiments
      }
    }
  }
}

/// A run's repetitions as one bar: those that failed in the verdict's colour, the rest in the hue;
/// while running, those done.
private struct RunsBar: View {
  let verdict: TestVerdict

  var body: some View {
    let v = verdict
    GeometryReader { box in
      let n = max(v.total, 1)
      let gap: CGFloat = n > 24 ? 1 : 2
      let w = max(1, (box.size.width - gap * CGFloat(n - 1)) / CGFloat(n))
      HStack(spacing: gap) {
        ForEach(0..<n, id: \.self) { i in
          RoundedRectangle(cornerRadius: 1, style: .continuous)
            .fill(color(i, v))
            .frame(width: w)
        }
      }
    }
  }

  private func color(_ i: Int, _ v: TestVerdict) -> Color {
    switch v.kind {
    case .notRun: Theme.overlay(0.08)
    case .running: i < v.failed ? Theme.accent : Theme.overlay(0.08)
    case .holds: Theme.accent.opacity(0.55)
    default: i < v.failed ? v.color : Theme.accent.opacity(0.4)
    }
  }
}

// MARK: - What went wrong

/// Each experiment that didn't hold: the picture where it ended, what broke and why, and what to do.
private struct WhatWentWrong: View {
  let experiments: [Replay.Experiment]

  var body: some View {
    let broken = experiments
      .filter { TestVerdict($0).failing }
      .sorted { a, b in
        let x = TestVerdict(a), y = TestVerdict(b)
        let fx = Double(x.failed) / Double(max(x.total, 1)), fy = Double(y.failed) / Double(max(y.total, 1))
        return fx != fy ? fx > fy : a.id < b.id
      }
    Panel("What went wrong", accessory: { if !broken.isEmpty { Text("\(broken.count)").foregroundStyle(Theme.fail) } }) {
      if broken.isEmpty {
        HStack(spacing: 10) {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.accent)
          Text("Nothing: every test held on its newest run.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
        }
      } else {
        VStack(spacing: 14) {
          ForEach(broken) { FindingCard(experiment: $0) }
        }
      }
    }
  }
}

private struct FindingCard: View {
  @Environment(AppModel.self) private var model
  let experiment: Replay.Experiment
  @State private var hovering = false
  @State private var copied = false

  var body: some View {
    let e = experiment
    let v = TestVerdict(e)
    let shape = RoundedRectangle(cornerRadius: Theme.radius + 2, style: .continuous)
    HStack(alignment: .top, spacing: 20) {
      evidence(e, v)
      VStack(alignment: .leading, spacing: 11) {
        Text(FindingText.headline(e))
          .font(Theme.sans(16, .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
          .lineSpacing(2).lineLimit(3).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 6) {
          SymbolChip(symbol: Pressure.symbol(e.pressure), text: Pressure.words(e.pressure) + (Pressure.place(e.pressure).map { " · \($0)" } ?? ""))
          SymbolChip(symbol: "arrow.right.circle", text: FlowGroup.title(e.flowKey))
          if let order = e.run?.variant { SymbolChip(symbol: "arrow.left.arrow.right", text: "order \(order)") }
        }
        if let rule = e.rules.broken.first {
          Line(label: "Broke") {
            Text(rule.id).font(Theme.mono(11.5)).foregroundStyle(Theme.fail).lineLimit(1)
              .help(rule.description ?? rule.id)
          }
        }
        if let fix = e.finding?.fix {
          Line(label: "Fix") {
            Text(fix.firstSentence).font(Theme.sans(12.5)).foregroundStyle(Theme.dim).lineLimit(2).fixedSize(horizontal: false, vertical: true)
              .help(fix)
          }
        }
        if let code = e.finding?.code, !code.isEmpty {
          Line(label: "Code") {
            HStack(spacing: 6) {
              ForEach(code.prefix(3), id: \.self) { CodeChip(ref: $0) }
            }
          }
        }
        HStack(spacing: 8) {
          Button {
            model.copy(FixPrompt.text(e, file: model.experiments.first { $0.id == e.id }?.file, project: model.status?.project.name))
            withAnimation(Theme.snappy) { copied = true }
            Task {
              try? await Task.sleep(for: .seconds(2))
              withAnimation(Theme.snappy) { copied = false }
            }
          } label: {
            Label(copied ? "Copied" : e.finding != nil ? "Copy fix prompt" : "Copy prompt", systemImage: copied ? "checkmark" : "doc.on.doc")
          }
          .buttonStyle(ActionButtonStyle(prominent: true))
          .help(e.finding != nil ? "A prompt for your coding agent: the bug, why, where, and how to prove the fix." : "A prompt for your coding agent: what breaks and how to see it, to find the cause and fix it.")
          Button {
            model.play(e.id)
          } label: {
            Label("Play", systemImage: "play.fill")
          }
          .buttonStyle(ActionButtonStyle())
          Button {
            model.runExperiments([e.id])
          } label: {
            Label("Run again", systemImage: "arrow.clockwise")
          }
          .buttonStyle(ActionButtonStyle())
          .disabled(model.runningJob != nil)
        }
        .padding(.top, 3)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(14)
    .background(shape.fill(Theme.overlay(0.03)))
    .overlay(shape.strokeBorder(Theme.line, lineWidth: 1))
  }

  /// Where it ended, as the run pictured it, with the verdict on it. Opens the player.
  private func evidence(_ e: Replay.Experiment, _ v: TestVerdict) -> some View {
    let shape = RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
    let evidence = FindingText.evidence(e)
    return ZStack(alignment: .bottomLeading) {
      if let frame = evidence.frame {
        ShotView(frame: frame)
      } else {
        Rectangle().fill(Theme.fill)
      }
      // The step after the picture, which never got one: where it went down.
      if let failed = evidence.failed {
        HStack(spacing: 5) {
          Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9))
          Text("Next, \u{201C}\(failed.step)\u{201D} \(TestVerdict(e).kind == .crashes ? "crashed" : "failed")").lineLimit(1)
        }
        .font(Theme.sans(11, .semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .background(Capsule().fill(Theme.fail.opacity(0.9)))
        .padding(9)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .help(failed.error ?? "")
      }
      HStack(spacing: 6) {
        Circle().fill(v.color).frame(width: 6, height: 6)
        Text("\(v.word) in \(v.count)").font(Theme.sans(11, .semibold)).foregroundStyle(.white)
      }
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(Capsule().fill(.black.opacity(0.62)))
      .padding(9)
      Image(systemName: "play.fill")
        .font(.system(size: 18))
        .foregroundStyle(.white)
        .frame(width: 46, height: 46)
        .background(Circle().fill(.black.opacity(0.55)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .opacity(hovering ? 1 : 0)
    }
    .frame(width: 272, height: 170)
    .clipShape(shape)
    .overlay(shape.strokeBorder(Theme.line, lineWidth: 1))
    .contentShape(shape)
    .onHover { h in withAnimation(Theme.snappy) { hovering = h } }
    .onTapGesture { model.play(e.id) }
    .help("Play its newest run")
  }

  private struct Line<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(label).label(Theme.ghost).frame(width: 34, alignment: .leading)
        content()
      }
    }
  }
}

/// A small rounded label with a symbol.
private struct SymbolChip: View {
  let symbol: String
  let text: String

  var body: some View {
    HStack(spacing: 5) {
      Image(systemName: symbol).font(.system(size: 9.5, weight: .medium))
      Text(text).lineLimit(1)
    }
    .font(Theme.sans(11))
    .foregroundStyle(Theme.dim)
    .padding(.horizontal, 8)
    .frame(height: 22)
    .background(Capsule().fill(Theme.overlay(0.06)))
  }
}

/// `ExportService.swift:36`: opens the file at that line.
private struct CodeChip: View {
  @Environment(AppModel.self) private var model
  let ref: String
  @State private var hovering = false

  var body: some View {
    Text((ref as NSString).lastPathComponent)
      .font(Theme.mono(10.5))
      .foregroundStyle(hovering ? Theme.text : Theme.dim)
      .lineLimit(1)
      .padding(.horizontal, 7)
      .frame(height: 22)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.overlay(hovering ? 0.1 : 0.06)))
      .contentShape(Rectangle())
      .onHover { hovering = $0 }
      .onTapGesture { model.openCode(ref) }
      .help("Open \(ref)")
  }
}

// MARK: - First run

/// A project with nothing to show yet: the next step, big.
private struct FirstRun: View {
  enum Stage { case noExperiments, neverRun }

  @Environment(AppModel.self) private var model
  let stage: Stage

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch stage {
      case .noExperiments: noExperiments
      case .neverRun: neverRun
      }
    }
    .frame(width: 520, alignment: .leading)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var noExperiments: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Set up. Now find what breaks.")
        .font(.system(size: 30, weight: .semibold)).tracking(-0.6).foregroundStyle(Theme.text)
        .rise()
      Text("Experiments are written by your coding agent. On a hunt it reads the app, picks a risky flow such as checkout, and tries what users do by accident: two tabs, a double click, a lost response, a late webhook. Each one it keeps is a file you commit.")
        .font(Theme.sans(14)).foregroundStyle(Theme.dim).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 14)
        .rise(0.04)
      HStack(spacing: 10) {
        Button {
          model.section = .hunt
        } label: {
          Label("Start a Hunt", systemImage: "scope")
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
        Button("Copy /windtunnel:hunt checkout") { model.copy("/windtunnel:hunt checkout") }
          .buttonStyle(LinkButtonStyle())
          .padding(.leading, 6)
      }
      .padding(.top, 28)
      .rise(0.08)
    }
  }

  private var neverRun: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("\(Fmt.plural(model.experiments.count, "experiment")), not run yet.")
        .font(.system(size: 30, weight: .semibold)).tracking(-0.6).foregroundStyle(Theme.text)
        .rise()
      Text("Each runs against its own copy of the app and the database, as many times and in as many orders as it asks for. The first run builds the app once, which takes a minute or two. No model is involved.")
        .font(Theme.sans(14)).foregroundStyle(Theme.dim).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 14)
        .rise(0.04)
      Button {
        model.runExperiments([])
      } label: {
        Label(model.runningJob != nil ? "Running…" : "Run All", systemImage: "play.fill")
      }
      .buttonStyle(ActionButtonStyle(prominent: true))
      .disabled(model.runningJob != nil)
      .padding(.top, 28)
      .rise(0.08)
      VStack(alignment: .leading, spacing: 6) {
        ForEach(model.experiments.prefix(8)) { e in
          Text(e.id).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
        }
        if model.experiments.count > 8 {
          Text("and \(model.experiments.count - 8) more").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
        }
      }
      .padding(.top, 32)
      .rise(0.12)
    }
  }
}

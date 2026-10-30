import ImageIO
import SwiftUI

/// How the agent tested, as a board to pan around: every experiment in the order it was first
/// run, and its newest run as the browser lived it. A lane per tab, a column per step, the page
/// when the step ended, what it sent, where the experiment pushed, then what the database said.
/// Click a page to see it large beside the board; ← and → step through.
struct ReplayPane: View {
  @Environment(AppModel.self) private var model
  @State private var selection: FrameRef? = Launch.value("--frame").flatMap { FrameRef($0) }
  @State private var order: Order = .asRun
  @State private var size: CGFloat = Launch.value("--size").flatMap(Double.init).map { CGFloat($0) } ?? 168
  @State private var pinchFrom: CGFloat?
  @State private var hovered: String?
  @State private var viewport: CGSize = .zero
  @FocusState private var focused: Bool

  enum Order: String, CaseIterable { case asRun = "As run", brokeFirst = "Broke first" }

  var body: some View {
    Group {
      if let replay = model.replay, !replay.experiments.isEmpty {
        let list = ordered(replay.experiments)
        HStack(spacing: 0) {
          VStack(alignment: .leading, spacing: 0) {
            ReplayHero(replay: replay, runs: model.runs, hovered: hovered, order: $order, size: $size)
              .padding(.horizontal, Theme.gutter)
              .padding(.top, 4)
              .padding(.bottom, 18)
              .rise()
            Hairline()
            board(list, BoardMetrics(frame: size))
          }
          if let selection, let e = list.first(where: { $0.id == selection.experiment }), e.frames.indices.contains(selection.index) {
            FrameInspector(experiment: e, index: selection.index, step: step) { withAnimation(Theme.snappy) { self.selection = nil } }
              .frame(width: 320)
              .transition(.move(edge: .trailing).combined(with: .opacity))
          }
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.leftArrow) { step(-1) }
        .onKeyPress(.rightArrow) { step(1) }
        .onExitCommand { withAnimation(Theme.snappy) { selection = nil } }
      } else if model.replay != nil {
        EmptyState(title: "No tests yet", text: "When the agent writes experiments and runs them, each one plays out here step by step: the pages, the requests, and where a rule broke.")
      } else if let error = model.replayError {
        EmptyState(title: "Couldn't load the runs", text: error)
      } else {
        VStack(spacing: 14) {
          DitherBar(width: 96)
          Text("Lining up the steps").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task { await model.loadReplay() }
  }

  private func board(_ list: [Replay.Experiment], _ m: BoardMetrics) -> some View {
    let width = list.map(m.width).max() ?? 600
    return ScrollViewReader { proxy in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
            BoardRow(number: number(of: e), experiment: e, m: m, selected: selection?.experiment == e.id ? selection?.index : nil) { index in
              focused = true
              let ref = FrameRef(experiment: e.id, index: index)
              withAnimation(Theme.snappy) { selection = selection == ref ? nil : ref }
            }
            .onHover { inside in
              if inside { hovered = e.id } else if hovered == e.id { hovered = nil }
            }
            .id(e.id)
            if i < list.count - 1 { Hairline().frame(width: width) }
          }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.bottom, 40)
        // A board narrower or shorter than the window stays at the top left, on a ground that fills it.
        .frame(minWidth: viewport.width, minHeight: viewport.height, alignment: .topLeading)
        .background(DotGrid())
      }
      .onGeometryChange(for: CGSize.self) { $0.size } action: { viewport = $0 }
      .onAppear {
        if let s = selection { proxy.scrollTo(s.experiment, anchor: .top) }
      }
      .onChange(of: selection) { _, now in
        guard let now else { return }
        // Only as far as it takes to show it: stepping along a row shouldn't jump.
        withAnimation(Theme.spring) { proxy.scrollTo(now, anchor: nil) }
      }
    }
    .simultaneousGesture(
      MagnifyGesture()
        .onChanged { g in
          let from = pinchFrom ?? size
          pinchFrom = from
          size = min(BoardMetrics.largest, max(BoardMetrics.smallest, from * g.magnification))
        }
        .onEnded { _ in pinchFrom = nil }
    )
  }

  /// Its place in the order the agent first ran them, whatever the order shown.
  private func number(of e: Replay.Experiment) -> Int {
    (model.replay?.experiments.firstIndex { $0.id == e.id } ?? 0) + 1
  }

  private func ordered(_ list: [Replay.Experiment]) -> [Replay.Experiment] {
    switch order {
    case .asRun: list
    case .brokeFirst: list.filter(\.broke) + list.filter { !$0.broke }
    }
  }

  /// The next or previous page in the chosen experiment, column by column.
  private func step(_ by: Int) -> KeyPress.Result {
    guard let s = selection, let e = model.replay?.experiments.first(where: { $0.id == s.experiment }) else { return .ignored }
    let path = e.frames.indices.sorted { (e.frames[$0].column, e.frames[$0].lane) < (e.frames[$1].column, e.frames[$1].lane) }
    guard let at = path.firstIndex(of: s.index) else { return .ignored }
    let next = at + by
    guard path.indices.contains(next) else { return .handled }
    withAnimation(Theme.snappy) { selection = FrameRef(experiment: e.id, index: path[next]) }
    return .handled
  }
}

/// One page on the board: an experiment and a frame of its newest run.
nonisolated struct FrameRef: Hashable {
  let experiment: String
  let index: Int

  init(experiment: String, index: Int) {
    self.experiment = experiment
    self.index = index
  }

  /// `checkout-second-tab:3`, from `--frame`.
  init?(_ text: String) {
    guard let colon = text.lastIndex(of: ":"), let n = Int(text[text.index(after: colon)...]) else { return nil }
    experiment = String(text[..<colon])
    index = n
  }
}

// MARK: - Geometry

/// Where things go on a row, from the width of a page. Text keeps its size; only the pages grow.
struct BoardMetrics {
  static let smallest: CGFloat = 112
  static let largest: CGFloat = 340

  let frame: CGFloat
  var shot: CGFloat { (frame * 10 / 16).rounded() }
  var gap: CGFloat { max(40, frame * 0.24) }
  var column: CGFloat { frame + gap }
  /// The tabs' names, left of their lanes.
  let laneLabel: CGFloat = 76
  /// The experiment's name and what it tries, over its lanes.
  let top: CGFloat = 64
  let stepHead: CGFloat = 26
  let caption: CGFloat = 58
  var lane: CGFloat { shot + 8 + caption + 12 }
  let provider: CGFloat = 24
  let result: CGFloat = 236
  let pad: CGFloat = 22

  func origin(column c: Int, lane l: Int) -> CGPoint {
    CGPoint(x: laneLabel + CGFloat(c) * column, y: top + stepHead + CGFloat(l) * lane)
  }

  func resultX(_ e: Replay.Experiment) -> CGFloat { laneLabel + CGFloat(max(e.columns.count, 1)) * column }

  func width(_ e: Replay.Experiment) -> CGFloat { max(resultX(e) + result, 720) }

  func height(_ e: Replay.Experiment) -> CGFloat {
    guard e.run != nil else { return top + 34 }
    return top + stepHead + CGFloat(max(e.lanes.count, 1)) * lane + (e.webhooks.isEmpty ? 0 : provider)
  }
}

extension View {
  /// At (x, y) in a top-leading ZStack, as layout (so scrolling to it finds it), not just drawing.
  fileprivate func place(_ x: CGFloat, _ y: CGFloat) -> some View {
    alignmentGuide(.leading) { _ in -x }.alignmentGuide(.top) { _ in -y }
  }
}

// MARK: - Above the board

private struct ReplayHero: View {
  let replay: Replay
  let runs: [RunListEntry]
  let hovered: String?
  @Binding var order: ReplayPane.Order
  @Binding var size: CGFloat
  @Environment(AppModel.self) private var model
  @State private var pointed: RunListEntry?

  var body: some View {
    let ran = replay.experiments.filter { $0.run != nil }
    let broke = replay.experiments.filter(\.broke)
    HStack(alignment: .bottom, spacing: 40) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("\(replay.experiments.count)").font(Theme.figure(44)).foregroundStyle(Theme.text)
          Text("tests, as the agent ran them").font(Theme.sans(15)).foregroundStyle(Theme.faint)
        }
        RunCode(runs: runs, hovered: hovered, pointed: $pointed)
          .padding(.top, 12)
        HStack(spacing: 0) {
          if let r = pointed {
            Text("\(r.experiment) · \(Tone.word(r.outcome).lowercased()) · \(Fmt.ago(r.started))")
          } else {
            Text(summary(ran: ran.count, broke: broke))
          }
          if stale && pointed == nil {
            Text("  ·  ")
            Button("Run all again to see every page") { model.runExperiments([]) }
              .buttonStyle(LinkButtonStyle())
              .disabled(model.runningJob != nil)
          }
        }
        .font(Theme.sans(12)).foregroundStyle(Theme.faint)
        .lineLimit(1)
        .padding(.top, 10)
      }
      .layoutPriority(1)
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 12) {
        TabStrip(items: ReplayPane.Order.allCases, selection: $order, size: 12) { o, _ in Text(o.rawValue) }
        HStack(spacing: 8) {
          Image(systemName: "photo").font(.system(size: 9))
          Slider(value: $size, in: BoardMetrics.smallest...BoardMetrics.largest).controlSize(.mini).frame(width: 96)
          Image(systemName: "photo").font(.system(size: 13))
        }
        .foregroundStyle(Theme.faint)
        .help("Page size (or pinch)")
      }
    }
  }

  /// Some newest runs are older than step screenshots.
  private var stale: Bool {
    replay.experiments.contains { e in !e.frames.isEmpty && e.frames.allSatisfy { $0.shot == nil } }
  }

  private func summary(ran: Int, broke: [Replay.Experiment]) -> String {
    var parts = ["\(Fmt.plural(replay.runs, "run")) since \(Fmt.day(ISO.date(replay.since)))"]
    if ran < replay.experiments.count { parts.append("\(replay.experiments.count - ran) not run yet") }
    parts.append(broke.isEmpty ? "every rule held" : "\(broke.count) broke a rule last time")
    return parts.joined(separator: "  ·  ")
  }
}

/// Every run on record, oldest first, a tick each in its outcome's colour: the agent's attempts
/// in order. Pointing at an experiment on the board picks out its own; pointing at a tick names it.
private struct RunCode: View {
  let runs: [RunListEntry]
  let hovered: String?
  @Binding var pointed: RunListEntry?
  @State private var pointer: CGFloat?
  @State private var width: CGFloat = 0

  var body: some View {
    let list = Array(runs.filter { $0.outcome != "running" }.sorted { $0.startedAt < $1.startedAt }.suffix(240))
    let at = index(list.count)
    Canvas { ctx, size in
      guard !list.isEmpty else { return }
      let step = size.width / CGFloat(list.count)
      let width = max(1, min(2, step - 1))
      for (i, r) in list.enumerated() {
        let mine = hovered == nil || hovered == r.experiment
        let height: CGFloat = (mine && hovered != nil) || at == i ? 18 : 14
        let rect = CGRect(x: CGFloat(i) * step, y: size.height - height, width: width, height: height)
        ctx.fill(Path(rect), with: .color(Tone(r.outcome).color.opacity(mine ? 1 : 0.22)))
      }
    }
    .frame(minWidth: 120, maxWidth: CGFloat(list.count) * 3, minHeight: 18, maxHeight: 18)
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .onContinuousHover { phase in
      if case .active(let p) = phase { pointer = p.x } else { pointer = nil }
      pointed = index(list.count).map { list[$0] }
    }
    .animation(Theme.snappy, value: hovered)
  }

  /// The tick under the pointer.
  private func index(_ count: Int) -> Int? {
    guard let pointer, width > 0, count > 0 else { return nil }
    return min(count - 1, max(0, Int(pointer / width * CGFloat(count))))
  }
}

// MARK: - A row

private struct BoardRow: View {
  let number: Int
  let experiment: Replay.Experiment
  let m: BoardMetrics
  let selected: Int?
  let onSelect: (Int) -> Void
  @Environment(AppModel.self) private var model

  private var tint: Color { experiment.broke ? Theme.fail : Theme.accent }

  var body: some View {
    let e = experiment
    ZStack(alignment: .topLeading) {
      ForEach(Array(e.columns.enumerated()), id: \.offset) { c, column in
        if !column.pressure.isEmpty { band(c) }
      }
      RowWires(experiment: e, m: m)
      RowHeader(number: number, experiment: e)
      ForEach(Array(e.lanes.enumerated()), id: \.offset) { l, lane in
        laneLabel(lane, l)
      }
      ForEach(Array(e.columns.enumerated()), id: \.offset) { c, column in
        StepHead(column: column, tint: tint)
          .frame(width: m.frame + 12, alignment: .leading)
          .place(m.origin(column: c, lane: 0).x, m.top + 3)
      }
      ForEach(Array(e.frames.enumerated()), id: \.offset) { i, f in
        let o = m.origin(column: f.column, lane: f.lane)
        FrameCell(frame: f, m: m, tint: e.columns[f.column].pressure.isEmpty ? nil : tint, selected: selected == i)
          .onTapGesture { onSelect(i) }
          .id(FrameRef(experiment: e.id, index: i))
          .place(o.x, o.y)
      }
      if !e.webhooks.isEmpty { provider(e) }
      if e.run != nil {
        ResultBlock(experiment: e)
          .frame(width: m.result - 28, alignment: .topLeading)
          .place(m.resultX(e) + 2, m.top + m.stepHead)
      } else {
        notRun.place(0, m.top)
      }
    }
    .frame(width: m.width(e), height: m.height(e), alignment: .topLeading)
    .padding(.vertical, m.pad)
  }

  /// Where the experiment pushed: behind the column, over every tab.
  private func band(_ c: Int) -> some View {
    let o = m.origin(column: c, lane: 0)
    let lanes = CGFloat(max(experiment.lanes.count, 1))
    return RoundedRectangle(cornerRadius: 9, style: .continuous)
      .fill(tint.opacity(0.055))
      .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(tint.opacity(0.2), lineWidth: 1))
      .frame(width: m.frame + 24, height: m.stepHead + lanes * m.lane - 6)
      .place(o.x - 12, m.top - 4)
  }

  private func laneLabel(_ lane: Replay.Lane, _ l: Int) -> some View {
    HStack(spacing: 5) {
      Circle().fill(Theme.actor(l)).frame(width: 5, height: 5)
      Text(lane.tab).font(Theme.mono(10.5)).foregroundStyle(Theme.dim).lineLimit(1)
    }
    .frame(width: m.laneLabel - 10, alignment: .leading)
    .place(0, m.origin(column: 0, lane: l).y + m.shot / 2 - 7)
    .help(lane.tab == lane.user ? "\(lane.user)'s browser tab" : "A second tab of \(lane.user)'s, the same session")
  }

  /// The payment provider's webhooks, under the step they came during.
  private func provider(_ e: Replay.Experiment) -> some View {
    let y = m.origin(column: 0, lane: e.lanes.count).y - 6
    let groups = Dictionary(grouping: e.webhooks, by: \.column).sorted { $0.key < $1.key }
    return ZStack(alignment: .topLeading) {
      HStack(spacing: 5) {
        Circle().strokeBorder(Theme.faint, lineWidth: 1).frame(width: 5, height: 5)
        Text("webhooks").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
      }
      ForEach(groups, id: \.key) { column, list in
        let pushed = e.columns.indices.contains(column) && e.columns[column].pressure.contains { $0.hasPrefix("webhook") }
        WebhookChip(deliveries: list, tint: pushed ? tint : nil)
          .place(m.origin(column: column, lane: 0).x, 0)
      }
    }
    .place(0, y)
  }

  private var notRun: some View {
    HStack(spacing: 14) {
      Text("Not run yet").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      Button {
        model.runExperiments([experiment.id])
      } label: {
        Label("Run", systemImage: "play.fill")
      }
      .buttonStyle(ActionButtonStyle())
      .disabled(model.runningJob != nil)
    }
    .padding(.top, 8)
  }
}

/// The experiment over its lanes: its name, how its newest run went, its runs so far, what it tries.
private struct RowHeader: View {
  let number: Int
  let experiment: Replay.Experiment
  @Environment(AppModel.self) private var model

  var body: some View {
    let e = experiment
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(String(format: "%02d", number)).font(Theme.mono(10.5)).foregroundStyle(Theme.ghost)
        Text(e.id).font(Theme.mono(13, .medium)).foregroundStyle(Theme.text).lineLimit(1)
        if let run = e.run {
          OutcomeBadge(outcome: e.broke ? "broken" : run.outcome == "error" ? "error" : "ok")
          if e.broke {
            Text(e.rules.broken.map(\.id).joined(separator: ", ")).font(Theme.mono(11.5)).foregroundStyle(Theme.fail).lineLimit(1)
          }
          Text("repetition \(run.rep) of \(run.reps) · \(Fmt.ago(ISO.date(run.startedAt)))").font(Theme.sans(11)).foregroundStyle(Theme.ghost).lineLimit(1)
          HStack(spacing: 3) {
            ForEach(e.history, id: \.id) { p in
              Circle().fill(Tone(p.outcome).color).frame(width: 5, height: 5)
                .help("\(Tone.word(p.outcome)) · \(Fmt.ago(ISO.date(p.startedAt)))")
            }
          }
          .padding(.leading, 6)
          .help("Its runs, oldest first")
          Button("Open run") {
            model.selectedRun = run.id
            model.section = .runs
          }
          .padding(.leading, 6)
          Button("Run again") { model.runExperiments([e.id]) }
            .disabled(model.runningJob != nil)
        }
      }
      .buttonStyle(LinkButtonStyle())
      if let d = e.description {
        Text(d).font(Theme.sans(12)).foregroundStyle(Theme.dim).lineLimit(2).lineSpacing(1.5)
          .frame(maxWidth: 640, alignment: .leading)
          .help(d)
      }
    }
    .padding(.leading, 0)
  }
}

/// The step's name over its column, with what the experiment did there.
private struct StepHead: View {
  let column: Replay.Column
  let tint: Color

  var body: some View {
    HStack(spacing: 6) {
      Text(column.step + (column.attempt.map { " · \($0)" } ?? ""))
        .font(Theme.mono(11, .medium))
        .foregroundStyle(column.pressure.isEmpty ? Theme.dim : tint)
        .lineLimit(1)
        .layoutPriority(1)
      if !column.pressure.isEmpty {
        Text(column.pressure.joined(separator: " · "))
          .font(Theme.sans(10.5))
          .foregroundStyle(tint.opacity(0.85))
          .lineLimit(1)
      }
    }
    .help(column.pressure.isEmpty ? column.step : "\(column.step): \(column.pressure.joined(separator: ", "))")
  }
}

/// A page as the step left it, and under it where it was, what it sent and what the harness did.
private struct FrameCell: View {
  let frame: Replay.Frame
  let m: BoardMetrics
  /// The pressure colour when the experiment pushed at this step.
  let tint: Color?
  let selected: Bool
  @State private var hover = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShotView(frame: frame)
        .frame(width: m.frame, height: m.shot)
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(edge, lineWidth: selected ? 1.5 : 1))
        .shadow(color: .black.opacity(hover || selected ? 0.22 : 0.1), radius: hover || selected ? 8 : 3, y: hover || selected ? 3 : 1)
      caption.frame(width: m.frame + 12, height: m.caption, alignment: .topLeading)
    }
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .animation(Theme.snappy, value: hover)
    .help(frame.actions.isEmpty ? frame.step : frame.actions.joined(separator: "\n"))
  }

  private var edge: Color {
    if selected { return Theme.accent }
    if frame.error != nil { return Theme.fail.opacity(0.7) }
    return hover ? Theme.lineStrong : Theme.line
  }

  private var caption: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 5) {
        Text(frame.path ?? "—").font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
        if let who = frame.as { Text("as \(who)").font(Theme.sans(10)).foregroundStyle(Theme.ghost) }
      }
      ForEach(Array(frame.requests.prefix(frame.requests.count > 2 ? 1 : 2).enumerated()), id: \.offset) { _, r in
        RequestLine(request: r, tint: tint)
      }
      if frame.requests.count > 2 {
        Text("+\(frame.requests.count - 1) more requests").font(Theme.sans(10)).foregroundStyle(Theme.ghost)
      }
      if let error = frame.error {
        Text(error).font(Theme.sans(10.5)).foregroundStyle(Theme.fail).lineLimit(1)
      } else if let note = (frame.tags + frame.requests.flatMap(\.tags)).first {
        Text(note).font(Theme.sans(10.5)).foregroundStyle(tint ?? Theme.faint).lineLimit(1)
      }
    }
  }
}

private struct RequestLine: View {
  let request: Replay.Request
  let tint: Color?

  var body: some View {
    let r = request
    let hot = r.pushed ? (tint ?? Theme.accent) : Theme.dim
    HStack(spacing: 4) {
      Text(r.method).foregroundStyle(Theme.faint)
      Text(r.path).foregroundStyle(hot).lineLimit(1).truncationMode(.middle)
      if r.count > 1 { Text("×\(r.count)").foregroundStyle(hot) }
      Text(statuses).foregroundStyle(r.failed ? Theme.fail : Theme.ghost)
    }
    .font(Theme.mono(10))
    .lineLimit(1)
    .help(([r.method + " " + r.path] + r.notes).joined(separator: "\n"))
  }

  private var statuses: String {
    var seen: [String] = []
    for s in request.statuses.map({ $0.map(String.init) ?? "lost" }) where !seen.contains(s) { seen.append(s) }
    return seen.joined(separator: " ")
  }
}

private struct WebhookChip: View {
  let deliveries: [Replay.Delivery]
  let tint: Color?

  var body: some View {
    let failed = deliveries.contains { ($0.status ?? 999) >= 400 }
    HStack(spacing: 5) {
      Image(systemName: "arrow.down.right").font(.system(size: 8, weight: .semibold))
      Text("webhook" + (deliveries.count > 1 ? " ×\(deliveries.count)" : ""))
      Text(deliveries.map { $0.status.map(String.init) ?? "lost" }.joined(separator: " ")).foregroundStyle(failed ? Theme.fail : Theme.ghost)
    }
    .font(Theme.mono(10))
    .foregroundStyle(tint ?? Theme.dim)
    .help(deliveries.map { "\($0.type) at \(Fmt.ms($0.at)): \($0.status.map(String.init) ?? "no answer")" }.joined(separator: "\n"))
  }
}

/// What the database said once the steps were done.
private struct ResultBlock: View {
  let experiment: Replay.Experiment

  var body: some View {
    let e = experiment
    VStack(alignment: .leading, spacing: 0) {
      if e.broke {
        ForEach(e.rules.broken, id: \.id) { rule in
          VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
              Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
              Text(rule.id).font(Theme.mono(11.5, .medium)).lineLimit(1)
            }
            .foregroundStyle(Theme.fail)
            if let d = rule.description { Text(d).font(Theme.sans(11)).foregroundStyle(Theme.dim).lineLimit(3) }
            if let s = rule.sample {
              Text(s + (rule.rows > 1 ? "  +\(rule.rows - 1)" : "")).font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(1)
            }
          }
          .padding(.bottom, 10)
        }
      } else if let run = e.run, run.outcome == "error" {
        Text("Couldn't finish").font(Theme.sans(12, .medium)).foregroundStyle(Theme.error)
        if let error = run.error { Text(error).font(Theme.sans(11)).foregroundStyle(Theme.dim).lineLimit(3).padding(.top, 4) }
      } else {
        HStack(spacing: 6) {
          Image(systemName: "checkmark").font(.system(size: 9, weight: .bold))
          Text("Every rule held").font(Theme.sans(12, .medium))
        }
        .foregroundStyle(Theme.dim)
        Text(Fmt.plural(e.rules.held, "rule") + " checked").font(Theme.sans(11)).foregroundStyle(Theme.ghost).padding(.top, 3).padding(.bottom, 10)
      }
      if !e.changes.isEmpty {
        Text(e.changes.prefix(4).joined(separator: " · ") + (e.changes.count > 4 ? " +\(e.changes.count - 4)" : ""))
          .font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(2).lineSpacing(1.5)
          .help("The database after the run: " + e.changes.joined(separator: ", "))
      }
    }
  }
}

// MARK: - Lines

/// The arrows between a tab's pages, a second tab branching off the first, and every tab into
/// what the database said.
private struct RowWires: View {
  let experiment: Replay.Experiment
  let m: BoardMetrics

  var body: some View {
    Canvas { ctx, _ in
      let e = experiment
      for l in e.lanes.indices {
        let mine = e.frames.filter { $0.lane == l }.sorted { $0.column < $1.column }
        guard let first = mine.first, let last = mine.last else { continue }
        for (a, b) in zip(mine, mine.dropFirst()) {
          arrow(&ctx, from: right(a), to: left(b), shading: .color(Theme.lineStrong))
        }
        // A tab that opened partway: from where its first tab was.
        if first.column > 0, let parent = e.lanes.firstIndex(where: { $0.tab == e.lanes[l].user }), parent != l,
          let from = e.frames.filter({ $0.lane == parent && $0.column < first.column }).max(by: { $0.column < $1.column })
        {
          branch(&ctx, from: right(from), to: left(first))
        }
        let end = right(last)
        arrow(&ctx, from: end, to: CGPoint(x: m.resultX(e) - 10, y: end.y), shading: .color(Theme.line))
      }
    }
    .frame(width: m.width(experiment), height: m.height(experiment))
    .allowsHitTesting(false)
  }

  private func left(_ f: Replay.Frame) -> CGPoint {
    let o = m.origin(column: f.column, lane: f.lane)
    return CGPoint(x: o.x - 8, y: o.y + m.shot / 2)
  }

  private func right(_ f: Replay.Frame) -> CGPoint {
    let o = m.origin(column: f.column, lane: f.lane)
    return CGPoint(x: o.x + m.frame + 8, y: o.y + m.shot / 2)
  }

  private func head(_ ctx: inout GraphicsContext, at b: CGPoint, shading: GraphicsContext.Shading) {
    var head = Path()
    head.move(to: CGPoint(x: b.x - 5, y: b.y - 3))
    head.addLine(to: b)
    head.addLine(to: CGPoint(x: b.x - 5, y: b.y + 3))
    ctx.stroke(head, with: shading, style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
  }

  private func arrow(_ ctx: inout GraphicsContext, from a: CGPoint, to b: CGPoint, shading: GraphicsContext.Shading) {
    guard b.x - a.x > 8 else { return }
    var line = Path()
    line.move(to: a)
    line.addLine(to: CGPoint(x: b.x - 1, y: b.y))
    ctx.stroke(line, with: shading, lineWidth: 1)
    head(&ctx, at: b, shading: shading)
  }

  private func branch(_ ctx: inout GraphicsContext, from a: CGPoint, to b: CGPoint) {
    var path = Path()
    path.move(to: a)
    let mid = (b.x - a.x) * 0.55
    path.addCurve(to: CGPoint(x: b.x - 1, y: b.y), control1: CGPoint(x: a.x + mid, y: a.y), control2: CGPoint(x: b.x - mid, y: b.y))
    let shading = GraphicsContext.Shading.color(Theme.accent.opacity(0.55))
    ctx.stroke(path, with: shading, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
    head(&ctx, at: b, shading: shading)
  }
}

/// The board's ground: a faint dot every 20 points.
private struct DotGrid: View {
  var body: some View {
    Canvas { ctx, size in
      let dot = GraphicsContext.Shading.color(Theme.overlay(0.07))
      var y: CGFloat = 10
      while y < size.height {
        var x: CGFloat = 10
        while x < size.width {
          ctx.fill(Path(ellipseIn: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5)), with: dot)
          x += 20
        }
        y += 20
      }
    }
    .allowsHitTesting(false)
  }
}

// MARK: - Pages

/// A step's screenshot, small. Runs from before screenshots show what the page said instead.
private struct ShotView: View {
  let frame: Replay.Frame
  @Environment(AppModel.self) private var model
  @State private var image: NSImage?

  var body: some View {
    ZStack(alignment: .topLeading) {
      Rectangle().fill(Theme.fill)
      if let image {
        // Pinned to the top: a phone's tall screen shows its header and first rows, not its middle.
        GeometryReader { box in
          Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fill)
            .frame(width: box.size.width, height: box.size.height, alignment: .top)
            .clipped()
        }
        .transition(.opacity)
      } else if frame.shot == nil {
        Text(frame.text ?? "")
          .font(Theme.sans(9)).foregroundStyle(Theme.ghost).lineSpacing(1)
          .padding(8)
          .help("No screenshot: this run is older than step screenshots. Run it again to see the page.")
      }
    }
    .task(id: frame.shot) {
      guard let path = frame.shot, let api = model.api else { return }
      if let cached = model.shots.cached(path) {
        image = cached
        return
      }
      let loaded = await model.shots.thumb(path, api: api)
      withAnimation(.easeOut(duration: 0.2)) { image = loaded }
    }
  }
}

/// Screenshots from the bridge, decoded small for the board and kept.
final class Shots {
  private var thumbs: [String: NSImage] = [:]
  private var loading: [String: Task<NSImage?, Never>] = [:]

  func cached(_ path: String) -> NSImage? { thumbs[path] }

  func thumb(_ path: String, api: API) async -> NSImage? {
    if let image = thumbs[path] { return image }
    if let task = loading[path] { return await task.value }
    let task = Task<NSImage?, Never> {
      guard let data = try? await api.data(path) else { return nil }
      return await Shots.decode(data, max: 720).map { NSImage(cgImage: $0, size: .zero) }
    }
    loading[path] = task
    let image = await task.value
    loading[path] = nil
    if let image { thumbs[path] = image }
    return image
  }

  /// The screenshot as taken, for the inspector.
  func full(_ path: String, api: API) async -> NSImage? {
    guard let data = try? await api.data(path) else { return nil }
    return NSImage(data: data)
  }

  func clear() {
    thumbs = [:]
    loading = [:]
  }

  @concurrent nonisolated static func decode(_ data: Data, max: Int) async -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: max,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}

// MARK: - Beside

/// One page large, and everything about its step.
private struct FrameInspector: View {
  let experiment: Replay.Experiment
  let index: Int
  let step: (Int) -> KeyPress.Result
  let close: () -> Void
  @Environment(AppModel.self) private var model
  @State private var image: NSImage?

  var body: some View {
    let f = experiment.frames[index]
    let lane = experiment.lanes.indices.contains(f.lane) ? experiment.lanes[f.lane].tab : ""
    let column = experiment.columns[f.column]
    let tint = experiment.broke ? Theme.fail : Theme.accent
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(f.step + (f.attempt.map { " · \($0)" } ?? "")).font(Theme.mono(13, .medium)).foregroundStyle(Theme.text)
        Text(lane + (f.as.map { " as \($0)" } ?? "")).font(Theme.mono(11)).foregroundStyle(Theme.faint)
        Spacer()
        Button { _ = step(-1) } label: { Image(systemName: "chevron.left") }.help("Previous page (←)")
        Button { _ = step(1) } label: { Image(systemName: "chevron.right") }.help("Next page (→)")
        Button(action: close) { Image(systemName: "xmark") }.help("Close (esc)").padding(.leading, 4)
      }
      .buttonStyle(LinkButtonStyle(color: Theme.faint))
      Text("\(experiment.id) · step \(f.column + 1) of \(experiment.columns.count) · \(Fmt.ms(f.start))–\(Fmt.ms(f.end))")
        .font(Theme.sans(11)).foregroundStyle(Theme.ghost).lineLimit(1).truncationMode(.middle)
        .padding(.top, 4)
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          page(f)
          if !column.pressure.isEmpty {
            Item(label: "Pushed here") {
              Text(column.pressure.joined(separator: " · ")).font(Theme.sans(12)).foregroundStyle(tint)
            }
          }
          if !f.actions.isEmpty {
            Item(label: "Did") {
              ForEach(Array(f.actions.enumerated()), id: \.offset) { _, a in Text(a).font(Theme.mono(11)).foregroundStyle(Theme.dim) }
            }
          }
          if !f.harness.isEmpty {
            Item(label: "The harness") {
              ForEach(Array(f.harness.enumerated()), id: \.offset) { _, h in Text(h).font(Theme.sans(12)).foregroundStyle(tint) }
            }
          }
          if !f.requests.isEmpty {
            Item(label: "Sent") {
              ForEach(Array(f.requests.enumerated()), id: \.offset) { _, r in
                VStack(alignment: .leading, spacing: 3) {
                  RequestLine(request: r, tint: column.pressure.isEmpty ? nil : tint)
                  ForEach(Array(r.notes.enumerated()), id: \.offset) { _, n in Text(n).font(Theme.sans(11)).foregroundStyle(Theme.faint) }
                  if let from = r.from { Text("sent by \(from)").font(Theme.sans(11)).foregroundStyle(Theme.faint) }
                }
              }
            }
          }
          if let error = f.error {
            Item(label: "Stopped") { Text(error).font(Theme.sans(12)).foregroundStyle(Theme.fail) }
          }
          if let text = f.text, !text.isEmpty {
            Item(label: "The page said") {
              Text(text).font(Theme.sans(11.5)).foregroundStyle(Theme.dim).lineSpacing(2).textSelection(.enabled)
            }
          }
          if let run = experiment.run {
            Button("Open run") {
              model.selectedRun = run.id
              model.section = .runs
            }
            .buttonStyle(ActionButtonStyle())
          }
        }
        .padding(.top, 16)
        .padding(.bottom, 24)
      }
      .scrollIndicators(.never)
    }
    .padding(.horizontal, 18)
    .padding(.top, 16)
    .frame(maxHeight: .infinity, alignment: .top)
    .overlay(alignment: .leading) { Hairline(vertical: true) }
    .task(id: f.shot) {
      image = nil
      guard let path = f.shot, let api = model.api else { return }
      image = model.shots.cached(path)
      if let full = await model.shots.full(path, api: api) { image = full }
    }
  }

  /// Width over height of a screenshot taller than it is wide.
  private var portrait: CGFloat? {
    guard let size = image?.size, size.height > size.width, size.height > 0 else { return nil }
    return size.width / size.height
  }

  private func page(_ f: Replay.Frame) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      ZStack {
        Rectangle().fill(Theme.fill)
        if let image {
          Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
        } else if f.shot == nil {
          Text("No screenshot for this run: it's older than step screenshots.").font(Theme.sans(11)).foregroundStyle(Theme.ghost).padding(12)
        }
      }
      // A phone's screen keeps its own shape, not a browser's.
      .aspectRatio(portrait ?? 16 / 10, contentMode: .fit)
      .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
      .frame(maxHeight: portrait == nil ? nil : 420, alignment: .leading)
      if let path = f.path { Text(path).font(Theme.mono(11)).foregroundStyle(Theme.faint) }
    }
  }
}

private struct Item<Content: View>: View {
  let label: String
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).label()
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

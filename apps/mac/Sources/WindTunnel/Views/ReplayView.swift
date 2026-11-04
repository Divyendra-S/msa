import ImageIO
import SwiftUI

/// How the agent tested, as a board to pan around: every experiment in the order it was first
/// run, and its newest run as the browser lived it. A lane per tab, a column per step, the page
/// when the step ended, what it sent, where the experiment pushed, then what the database said.
/// Play a test, or click one of its pages, to watch its run step by step (`RunPlayer`).
struct ReplayPane: View {
  @Environment(AppModel.self) private var model
  @State private var player: PlayerRef? = Launch.value("--play").flatMap { PlayerRef($0) }
    ?? Launch.value("--frame").flatMap { FrameRef($0) }.map { PlayerRef(experiment: $0.experiment, frame: $0.index) }
  @State private var order: Order = .asRun
  @State private var size: CGFloat = Launch.value("--size").flatMap(Double.init).map { CGFloat($0) } ?? 200
  @State private var pinchFrom: CGFloat?
  @State private var hovered: String?
  @State private var viewport: CGSize = .zero

  enum Order: String, CaseIterable { case asRun = "As run", brokeFirst = "Broke first" }

  var body: some View {
    Group {
      if let replay = model.replay, !replay.experiments.isEmpty {
        let list = ordered(replay.experiments)
        ZStack {
          // Kept under the player, so going back finds the board where it was.
          VStack(alignment: .leading, spacing: 0) {
            ReplayHero(replay: replay, runs: model.runs, hovered: hovered, order: $order, size: $size) {
              guard let first = list.first(where: { $0.run != nil }) else { return }
              withAnimation(Theme.snappy) { player = PlayerRef(experiment: first.id, autoplay: true, chain: true) }
            }
              .padding(.horizontal, Theme.gutter)
              .padding(.top, 4)
              .padding(.bottom, 18)
              .rise()
            Hairline()
            board(list, BoardMetrics(frame: size))
          }
          .opacity(player == nil ? 1 : 0)
          .allowsHitTesting(player == nil)
          .accessibilityHidden(player != nil)
          if let p = resolved(player, list), let i = list.firstIndex(where: { $0.id == p.experiment }) {
            RunPlayer(
              experiment: list[i], number: number(of: list[i]), place: (i + 1, list.count), start: p,
              previous: i > 0 ? list[i - 1] : nil, next: list[(i + 1)...].first { $0.run != nil },
              open: { id, chain in withAnimation(Theme.snappy) { player = PlayerRef(experiment: id, autoplay: true, chain: chain) } },
              close: { withAnimation(Theme.snappy) { player = nil } }
            )
            .id(p.experiment)
            .transition(.opacity.combined(with: .scale(scale: 0.985)))
          }
        }
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
    // A test the Overview asked to play.
    .onAppear { takePlayRequest() }
    .onChange(of: model.playRequest) { takePlayRequest() }
  }

  private func takePlayRequest() {
    guard let request = model.playRequest else { return }
    model.playRequest = nil
    withAnimation(Theme.snappy) { player = request }
  }

  private func board(_ list: [Replay.Experiment], _ m: BoardMetrics) -> some View {
    let width = list.map(m.width).max() ?? 600
    return ScrollView([.horizontal, .vertical]) {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(list.enumerated()), id: \.element.id) { i, e in
          BoardRow(number: number(of: e), experiment: e, m: m) { ref in
            withAnimation(Theme.snappy) { player = ref }
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

  /// `--play all`: the first test that ran.
  private func resolved(_ p: PlayerRef?, _ list: [Replay.Experiment]) -> PlayerRef? {
    guard var p, p.experiment == PlayerRef.all, !list.contains(where: { $0.id == p.experiment }) else { return p }
    guard let first = list.first(where: { $0.run != nil }) else { return nil }
    p = PlayerRef(experiment: first.id, autoplay: true, chain: true)
    return p
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
}

/// One page on the board: an experiment and a frame of its newest run (`--frame`).
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
  let playAll: () -> Void
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
        Button(action: playAll) { Label("Play all", systemImage: "play.fill") }
          .buttonStyle(ActionButtonStyle(prominent: true))
          .disabled(ran.isEmpty)
          .help("Watch every test step by step, one after another, in the order below")
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

  /// Some newest runs are older than step screenshots (a Swift scenario's steps have none).
  private var stale: Bool {
    replay.experiments.contains { e in e.scenario == nil && !e.frames.isEmpty && e.frames.allSatisfy { $0.shot == nil } }
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
  /// Plays the run in the player, from a step or one of its pages.
  let play: (PlayerRef) -> Void
  @Environment(AppModel.self) private var model

  private var tint: Color { experiment.broke ? Theme.fail : Theme.accent }

  var body: some View {
    let e = experiment
    ZStack(alignment: .topLeading) {
      ForEach(Array(e.columns.enumerated()), id: \.offset) { c, column in
        if !column.pressure.isEmpty { band(c) }
      }
      RowWires(experiment: e, m: m)
      RowHeader(number: number, experiment: e) { play(PlayerRef(experiment: e.id, autoplay: true)) }
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
        FrameCell(frame: f, m: m, tint: e.columns[f.column].pressure.isEmpty ? nil : tint)
          .onTapGesture { play(PlayerRef(experiment: e.id, frame: i)) }
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
  let play: () -> Void
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
          Button(action: play) { Label("Play", systemImage: "play.fill") }
            .buttonStyle(PlayButtonStyle(tint: e.broke ? Theme.fail : e.run?.outcome == "error" ? Theme.error : Theme.text))
            .help("Watch this run step by step, to what it found")
            .padding(.leading, 8)
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
  @State private var hover = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ShotView(frame: frame)
        .frame(width: m.frame, height: m.shot)
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(edge, lineWidth: 1))
        .overlay {
          if hover {
            Image(systemName: "play.fill").font(.system(size: 13)).foregroundStyle(.white)
              .frame(width: 34, height: 34).background(Circle().fill(.black.opacity(0.55)))
              .transition(.opacity)
          }
        }
        .shadow(color: .black.opacity(hover ? 0.22 : 0.1), radius: hover ? 8 : 3, y: hover ? 3 : 1)
      caption.frame(width: m.frame + 12, height: m.caption, alignment: .topLeading)
    }
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .animation(Theme.snappy, value: hover)
    .help("Play from \(frame.step)" + (frame.actions.isEmpty ? "" : "\n" + frame.actions.joined(separator: "\n")))
  }

  private var edge: Color {
    if frame.error != nil { return Theme.fail.opacity(0.7) }
    return hover ? Theme.lineStrong : Theme.line
  }

  private var caption: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 5) {
        Text(frame.path ?? (frame.points == nil ? "—" : "")).font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
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

struct RequestLine: View {
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
struct DotGrid: View {
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

/// A step's screenshot, small. Runs from before screenshots show what the page said instead, and
/// a Swift scenario's step the probe points its code reached.
struct ShotView: View {
  let frame: Replay.Frame
  /// Too small for the probe points' names: a step without a picture shows a symbol, and its error.
  var compact = false
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
      } else if compact && (frame.points != nil || frame.shot == nil) {
        VStack(spacing: 4) {
          Image(systemName: frame.error != nil ? "exclamationmark.triangle" : "curlybraces")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(frame.error != nil ? Theme.fail : Theme.ghost)
          Text(frame.error != nil ? "failed" : "code only").font(Theme.sans(9)).foregroundStyle(frame.error != nil ? Theme.fail : Theme.ghost)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .help(frame.error ?? (["No window: the probe points this step's code reached"] + (frame.points ?? [])).joined(separator: "\n"))
      } else if let points = frame.points {
        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 4) {
            Image(systemName: "curlybraces").font(.system(size: 8))
            Text("no window, code only")
          }
          .font(Theme.sans(9)).foregroundStyle(Theme.faint)
          .padding(.bottom, 2)
          if let error = frame.error {
            Text(error).font(Theme.sans(9, .medium)).foregroundStyle(Theme.fail).lineLimit(2)
          }
          // The point, then what the run did there under it.
          ForEach(Array(points.prefix(5).enumerated()), id: \.offset) { _, point in
            let parts = point.components(separatedBy: " · ")
            VStack(alignment: .leading, spacing: 1) {
              Text(parts[0]).font(Theme.mono(9.5)).foregroundStyle(parts.count > 1 ? Theme.text : Theme.dim).lineLimit(1)
              if parts.count > 1 {
                Text(parts.dropFirst().joined(separator: " · ")).font(Theme.sans(9)).foregroundStyle(Theme.accent).lineLimit(2)
              }
            }
          }
          if points.isEmpty { Text("reached no probe point").font(Theme.sans(9)).foregroundStyle(Theme.ghost) }
        }
        .padding(8)
        .help((["The probe points this step's code reached"] + points).joined(separator: "\n"))
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

/// Screenshots from the bridge: decoded small for the board, and whole for the player, and kept.
final class Shots {
  private var thumbs: [String: NSImage] = [:]
  private var loading: [String: Task<NSImage?, Never>] = [:]
  /// Whole screenshots, the newest few: a 2560-pixel one is 16 MB decoded.
  private var fulls: [String: NSImage] = [:]
  private var fullOrder: [String] = []
  private var loadingFull: [String: Task<NSImage?, Never>] = [:]
  private static let keptFull = 40

  func cached(_ path: String) -> NSImage? { thumbs[path] }

  func cachedFull(_ path: String) -> NSImage? { fulls[path] }

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

  /// The screenshot as taken, decoded off the main thread, for the player.
  func full(_ path: String, api: API) async -> NSImage? {
    if let image = fulls[path] { return image }
    if let task = loadingFull[path] { return await task.value }
    let task = Task<NSImage?, Never> {
      guard let data = try? await api.data(path) else { return nil }
      return await Shots.decode(data).map { NSImage(cgImage: $0, size: .zero) }
    }
    loadingFull[path] = task
    let image = await task.value
    loadingFull[path] = nil
    if let image {
      fulls[path] = image
      fullOrder.append(path)
      if fullOrder.count > Self.keptFull { fulls[fullOrder.removeFirst()] = nil }
    }
    return image
  }

  func clear() {
    thumbs = [:]
    loading = [:]
    fulls = [:]
    fullOrder = []
    loadingFull = [:]
  }

  /// The whole image, decoded now rather than when it is first drawn.
  @concurrent nonisolated static func decode(_ data: Data) async -> CGImage? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
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

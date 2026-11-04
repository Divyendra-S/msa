import SwiftUI

/// The test the player shows, and where it starts: a step (a column), or the step of a frame on
/// the board (`--frame`).
nonisolated struct PlayerRef: Equatable {
  let experiment: String
  var column = 0
  var frame: Int?
  var autoplay = false
  /// Goes on to the next test once this one's result has shown: Play all.
  var chain = false

  /// `checkout-two-buyers`, or from a step `checkout-two-buyers:2`, playing; or `all`, from `--play`.
  init?(_ text: String) {
    let parts = text.split(separator: ":", maxSplits: 1).map(String.init)
    guard let id = parts.first, !id.isEmpty else { return nil }
    experiment = id
    column = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
    autoplay = true
    chain = id == Self.all
  }

  /// Every test, one after another: `--play all`.
  static let all = "all"

  init(experiment: String, column: Int = 0, frame: Int? = nil, autoplay: Bool = false, chain: Bool = false) {
    self.experiment = experiment
    self.column = column
    self.frame = frame
    self.autoplay = autoplay
    self.chain = chain
  }
}

/// One test's newest run, played back: each step's screen large, the whole flow along the bottom,
/// what the step did beside it, and at the end what broke, why, and what would fix it. Space plays
/// and pauses, ← and → step, i shows or hides the details, esc goes back to every test. Pinch or
/// double-click the screen to zoom; the zoom stays as the steps change, to compare one place across
/// them. Played from Play all, it goes on to the next test after each result.
struct RunPlayer: View {
  let experiment: Replay.Experiment
  let number: Int
  /// Its place in the tests as listed, and how many there are.
  let place: (Int, Int)
  let previous: Replay.Experiment?
  let next: Replay.Experiment?
  let chain: Bool
  /// Opens another test; `true` goes on playing every test from it.
  let open: (String, Bool) -> Void
  let close: () -> Void
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// A column, or `experiment.columns.count` for the verdict.
  @State private var position: Int
  @State private var playing: Bool
  /// While playing, when the current step began to show; and how long it had shown before a pause.
  @State private var shownSince = Date()
  @State private var shownBefore: TimeInterval = 0
  @State private var zoom: CGFloat = 1
  @State private var zoomFrom: CGFloat?
  @State private var pan: CGSize = .zero
  @State private var panFrom: CGSize?
  @AppStorage("playerShowsNotes") private var showsNotes = true
  @FocusState private var focused: Bool

  /// How long each step shows while playing.
  static let dwell: TimeInterval = 2.6
  /// How long the result shows before Play all goes on to the next test.
  static let verdictDwell: TimeInterval = 6

  init(
    experiment: Replay.Experiment, number: Int, place: (Int, Int), start: PlayerRef, previous: Replay.Experiment?,
    next: Replay.Experiment?, open: @escaping (String, Bool) -> Void, close: @escaping () -> Void
  ) {
    self.experiment = experiment
    self.number = number
    self.place = place
    self.previous = previous
    self.next = next
    self.chain = start.chain
    self.open = open
    self.close = close
    let column = start.frame.flatMap { experiment.frames.indices.contains($0) ? experiment.frames[$0].column : nil } ?? start.column
    _position = State(initialValue: min(max(0, column), experiment.columns.count))
    _playing = State(initialValue: start.autoplay && !experiment.columns.isEmpty)
  }

  private var end: Int { experiment.columns.count }

  var body: some View {
    VStack(spacing: 0) {
      PlayerHeader(
        experiment: experiment, number: number, place: place, previous: previous, next: next, playingAll: chain && playing,
        open: { open($0, false) }, close: close
      )
        .padding(.horizontal, Theme.gutter)
        .padding(.top, 4)
        .padding(.bottom, 16)
      Hairline()
      Group {
        if position < end {
          HStack(spacing: 0) {
            stage
            if showsNotes {
              StepNotes(experiment: experiment, column: position)
                .frame(width: 330)
                .overlay(alignment: .leading) { Hairline(vertical: true) }
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
          }
        } else {
          VerdictView(experiment: experiment, next: next, open: { open($0, false) }) { go(0, play: true) }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .transition(.opacity)
      .id(position)
      Hairline()
      TimelineView(.animation(minimumInterval: 1 / 30, paused: !playing)) { context in
        FlowStrip(
          experiment: experiment, position: position, playing: playing, fraction: fraction(at: context.date),
          go: { go($0) }, toggle: toggle
        )
      }
    }
    .focusable()
    .focused($focused)
    .focusEffectDisabled()
    .onKeyPress(.leftArrow) {
      go(position - 1)
      return .handled
    }
    .onKeyPress(.rightArrow) {
      go(position + 1)
      return .handled
    }
    .onKeyPress(.space) {
      toggle()
      return .handled
    }
    .onKeyPress("i") {
      withAnimation(Theme.snappy) { showsNotes.toggle() }
      return .handled
    }
    .onExitCommand(perform: close)
    .onAppear { focused = true }
    .task { await preload() }
    .task(id: Tick(position: position, playing: playing)) { await advance() }
  }

  // MARK: The stage

  private var stage: some View {
    let column = experiment.columns[position]
    let list = frames(in: position)
    let tint = experiment.broke ? Theme.fail : Theme.accent
    return VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text("Step \(position + 1) of \(end)").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        Text(column.step + (column.attempt.map { " · \($0)" } ?? "")).font(Theme.mono(16, .medium)).foregroundStyle(Theme.text)
        if !column.pressure.isEmpty {
          Chip(text: "pushed here: " + column.pressure.joined(separator: " · "), tint: tint)
        }
        Spacer(minLength: 8)
        if zoom != 1 {
          Text("\(Int((zoom * 100).rounded()))%").font(Theme.mono(11)).foregroundStyle(Theme.faint)
          Button("Fit") { fit() }.buttonStyle(LinkButtonStyle()).help("Back to the whole screen (double-click)")
        } else if list.contains(where: { $0.1.shot != nil }) {
          Text("Pinch or double-click to zoom").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
        }
        Button { withAnimation(Theme.snappy) { showsNotes.toggle() } } label: { Image(systemName: "sidebar.right") }
          .buttonStyle(LinkButtonStyle(color: showsNotes ? Theme.dim : Theme.faint, size: 13))
          .help(showsNotes ? "Hide the details, for a larger screen (i)" : "Show what the step did (i)")
          .padding(.leading, 6)
      }
      .padding(.horizontal, 26)
      .padding(.top, 18)
      GeometryReader { box in
        let gap: CGFloat = 20
        let count = CGFloat(max(list.count, 1))
        let labels: CGFloat = list.count > 1 ? 26 : 0
        let cell = CGSize(width: (box.size.width - gap * (count - 1)) / count, height: max(40, box.size.height - labels))
        HStack(alignment: .center, spacing: gap) {
          ForEach(list, id: \.0) { _, frame in
            VStack(alignment: .leading, spacing: 8) {
              if list.count > 1 { LaneTag(experiment: experiment, frame: frame) }
              StagePicture(frame: frame, scenario: experiment.scenario != nil, tint: column.pressure.isEmpty ? nil : tint)
                .frame(maxWidth: cell.width, maxHeight: cell.height)
            }
          }
        }
        .frame(width: box.size.width, height: box.size.height)
        .scaleEffect(zoom)
        .offset(pan)
      }
      .padding(26)
      .clipped()
      .contentShape(Rectangle())
      .gesture(magnify)
      .simultaneousGesture(drag)
      .onTapGesture(count: 2) {
        withAnimation(Theme.spring) {
          if zoom == 1 { zoom = 2 } else { fit() }
        }
      }
    }
    .background(DotGrid())
  }

  private var magnify: some Gesture {
    MagnifyGesture()
      .onChanged { g in
        let from = zoomFrom ?? zoom
        zoomFrom = from
        zoom = min(5, max(1, from * g.magnification))
      }
      .onEnded { _ in
        zoomFrom = nil
        if zoom < 1.04 { withAnimation(Theme.snappy) { fit() } }
      }
  }

  private var drag: some Gesture {
    DragGesture(minimumDistance: 2)
      .onChanged { g in
        guard zoom > 1 else { return }
        let from = panFrom ?? pan
        panFrom = from
        pan = CGSize(width: from.width + g.translation.width, height: from.height + g.translation.height)
      }
      .onEnded { _ in panFrom = nil }
  }

  private func fit() {
    zoom = 1
    pan = .zero
  }

  /// The frames of a step, one per tab, in lane order, with their index on the board.
  private func frames(in column: Int) -> [(Int, Replay.Frame)] {
    experiment.frames.enumerated()
      .filter { $0.element.column == column }
      .sorted { $0.element.lane < $1.element.lane }
      .map { ($0.offset, $0.element) }
  }

  // MARK: Playing

  private struct Tick: Equatable {
    let position: Int
    let playing: Bool
  }

  /// How long a step shows while playing; the result shows longer.
  private func dwell(_ at: Int) -> TimeInterval { at < end ? Self.dwell : Self.verdictDwell }

  /// Play all, with a test after this one.
  private var chaining: Bool { chain && next != nil }

  /// How far through the current step playing is, 0 to 1.
  private func fraction(at now: Date) -> Double {
    let shown = shownBefore + (playing ? now.timeIntervalSince(shownSince) : 0)
    return min(1, max(0, shown / dwell(position)))
  }

  private func advance() async {
    guard playing, position < end || chaining else { return }
    try? await Task.sleep(for: .seconds(max(0, dwell(position) - shownBefore)))
    guard !Task.isCancelled, playing else { return }
    if position == end, let next {
      open(next.id, true)
      return
    }
    go(position + 1)
    if position == end && !chaining { playing = false }
  }

  private func go(_ to: Int, play: Bool = false) {
    let to = min(max(0, to), end)
    shownBefore = 0
    shownSince = .now
    if play { playing = true }
    guard to != position else { return }
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.28)) { position = to }
  }

  private func toggle() {
    if playing {
      shownBefore += Date.now.timeIntervalSince(shownSince)
      playing = false
    } else if position >= end {
      go(0, play: true)
    } else {
      shownSince = .now
      playing = true
    }
  }

  /// Every screen of the run, so playing never waits on one.
  private func preload() async {
    guard let api = model.api else { return }
    for frame in experiment.frames {
      if let path = frame.shot { _ = await model.shots.full(path, api: api) }
    }
  }
}

// MARK: - Above

private struct PlayerHeader: View {
  let experiment: Replay.Experiment
  let number: Int
  let place: (Int, Int)
  let previous: Replay.Experiment?
  let next: Replay.Experiment?
  let playingAll: Bool
  let open: (String) -> Void
  let close: () -> Void
  @Environment(AppModel.self) private var model

  var body: some View {
    let e = experiment
    let tint = e.broke ? Theme.fail : Theme.accent
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Button(action: close) { Label("All tests", systemImage: "chevron.left") }
          .help("Back to every test (esc)")
          .padding(.trailing, 10)
        Text(String(format: "%02d", number)).font(Theme.mono(11)).foregroundStyle(Theme.ghost)
        Text(e.id).font(Theme.mono(16, .medium)).foregroundStyle(Theme.text).lineLimit(1).layoutPriority(2)
        if let run = e.run {
          OutcomeBadge(outcome: e.broke ? "broken" : run.outcome == "error" ? "error" : "ok", large: true)
        }
        Spacer(minLength: 12)
        Text(playingAll ? "Playing every test · \(place.0) of \(place.1)" : "test \(place.0) of \(place.1)")
          .font(Theme.sans(11.5, playingAll ? .medium : .regular))
          .foregroundStyle(playingAll ? Theme.accent : Theme.ghost)
          .padding(.trailing, 8)
        if let run = e.run {
          Button("Open run") {
            model.selectedRun = run.id
            model.section = .runs
          }
        }
        Button("Run again") { model.runExperiments([e.id]) }
          .disabled(model.runningJob != nil)
        HStack(spacing: 2) {
          Button { if let previous { open(previous.id) } } label: { Image(systemName: "chevron.up").frame(width: 18) }
            .disabled(previous == nil)
            .help(previous.map { "Previous test: \($0.id)" } ?? "")
          Button { if let next { open(next.id) } } label: { Image(systemName: "chevron.down").frame(width: 18) }
            .disabled(next == nil)
            .help(next.map { "Next test: \($0.id)" } ?? "")
        }
        .padding(.leading, 6)
      }
      .buttonStyle(LinkButtonStyle())
      if let d = e.description {
        Text(d).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineLimit(2).lineSpacing(2)
          .frame(maxWidth: 880, alignment: .leading)
          .help(d)
      }
      HStack(spacing: 6) {
        if !e.pressure.isEmpty {
          Text("What it does to the app").font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
          ForEach(e.pressure, id: \.self) { p in Chip(text: Self.words(p), tint: tint) }
        }
        Spacer(minLength: 12)
        if let run = e.run {
          Text(Self.shown(run)).font(Theme.sans(11.5)).foregroundStyle(Theme.ghost).lineLimit(1)
            .help("The run shown: its newest, and the repetition that broke a rule if one did")
        }
      }
    }
  }

  /// `project.save: at once`, `export.pumped: slowed 800ms at cancel`.
  static func words(_ p: AppMap.Pressure) -> String {
    let target = p.routes.count == 1 ? p.routes[0].replacingOccurrences(of: "POINT ", with: "") : nil
    return [target, p.what].compactMap { $0 }.joined(separator: ": ") + (p.step.map { " at \($0)" } ?? "")
  }

  /// `repetition 3 of 9, let go 2,1 · 20.1 s · 6 min ago`.
  static func shown(_ run: Replay.Run) -> String {
    let order = run.variant.map { $0 == "together" ? ", let go together" : ", in the order \($0)" } ?? ""
    return "repetition \(run.rep) of \(run.reps)\(order) · \(Fmt.ms(run.durationMs)) · \(Fmt.ago(ISO.date(run.startedAt)))"
  }
}

/// A few words in a tint, on a faint wash of it.
struct Chip: View {
  let text: String
  let tint: Color

  var body: some View {
    Text(text)
      .font(Theme.sans(11, .medium))
      .foregroundStyle(tint)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(Capsule().fill(tint.opacity(0.1)))
      .overlay(Capsule().strokeBorder(tint.opacity(0.25), lineWidth: 1))
  }
}

private struct LaneTag: View {
  let experiment: Replay.Experiment
  let frame: Replay.Frame

  var body: some View {
    let lane = experiment.lanes.indices.contains(frame.lane) ? experiment.lanes[frame.lane].tab : ""
    HStack(spacing: 6) {
      Circle().fill(Theme.actor(frame.lane)).frame(width: 6, height: 6)
      Text(lane).font(Theme.mono(11.5)).foregroundStyle(Theme.dim)
      if let who = frame.as { Text("as \(who)").font(Theme.sans(11)).foregroundStyle(Theme.faint) }
      if let path = frame.path { Text(path).font(Theme.mono(11)).foregroundStyle(Theme.ghost).lineLimit(1).truncationMode(.middle) }
    }
    .frame(height: 18)
  }
}

// MARK: - A screen

/// A step's screen as large as it fits, at full resolution; a step with no screen says what ran.
private struct StagePicture: View {
  let frame: Replay.Frame
  let scenario: Bool
  let tint: Color?
  @Environment(AppModel.self) private var model
  @State private var image: NSImage?

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
    Group {
      if let image {
        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
          .clipShape(shape)
          .overlay(shape.strokeBorder(frame.error != nil ? Theme.fail.opacity(0.8) : Theme.lineStrong, lineWidth: frame.error != nil ? 1.5 : 1))
          .overlay(alignment: .bottomLeading) {
            if let error = frame.error { ErrorBand(error: error).padding(12) }
          }
          .shadow(color: .black.opacity(0.3), radius: 22, y: 10)
      } else if frame.shot != nil {
        shape.fill(Theme.fill).aspectRatio(16 / 10, contentMode: .fit)
          .overlay { DitherBar(width: 80) }
      } else {
        NoScreen(frame: frame, scenario: scenario, tint: tint).aspectRatio(16 / 10, contentMode: .fit)
      }
    }
    .task(id: frame.shot) {
      guard let path = frame.shot, let api = model.api else {
        image = nil
        return
      }
      image = model.shots.cachedFull(path) ?? model.shots.cached(path)
      if let full = await model.shots.full(path, api: api) { image = full }
    }
  }
}

/// Where a step stopped, over its screen.
private struct ErrorBand: View {
  let error: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Image(systemName: "xmark.octagon.fill")
      Text(error).lineLimit(2)
    }
    .font(Theme.sans(12.5, .medium))
    .foregroundStyle(.white)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.fail.opacity(0.92)))
  }
}

/// A step with nothing on screen: the code it reached (a Swift scenario) or what the page said (a
/// run older than step screenshots), and where it stopped.
private struct NoScreen: View {
  let frame: Replay.Frame
  let scenario: Bool
  let tint: Color?

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
    let points = frame.requests.filter { $0.method == "POINT" }
    ZStack(alignment: .topLeading) {
      shape.fill(Theme.well)
      shape.strokeBorder(frame.error != nil ? Theme.fail.opacity(0.6) : Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [5, 4]))
      VStack(alignment: .leading, spacing: 18) {
        HStack(spacing: 8) {
          Image(systemName: scenario ? "curlybraces" : "doc.text")
          Text(scenario ? "No window at this step: its code runs out of sight" : "No screenshot: this run is older than step screenshots")
        }
        .font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
        if let error = frame.error {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "xmark.octagon.fill")
            Text(error).lineLimit(3)
          }
          .font(Theme.sans(16, .medium)).foregroundStyle(Theme.fail)
        }
        if scenario {
          VStack(alignment: .leading, spacing: 10) {
            Text(points.isEmpty ? "Its code reached no probe point" : "The code it reached").label()
            ForEach(Array(points.enumerated()), id: \.offset) { _, p in PointLine(point: p, tint: tint, size: 15) }
          }
        } else if let text = frame.text, !text.isEmpty {
          Text(text).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3)
        }
      }
      .padding(30)
    }
  }
}

/// A probe point the code reached, and what the run did there.
private struct PointLine: View {
  let point: Replay.Request
  let tint: Color?
  var size: CGFloat = 12

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        Image(systemName: "smallcircle.filled.circle").font(.system(size: size * 0.7)).foregroundStyle(Theme.faint)
        Text(point.path + (point.count > 1 ? " ×\(point.count)" : "")).font(Theme.mono(size, .medium)).foregroundStyle(Theme.text)
      }
      ForEach(Array(point.notes.enumerated()), id: \.offset) { _, n in
        Text(n).font(Theme.sans(size - 2)).foregroundStyle(tint ?? Theme.accent).padding(.leading, size + 2)
      }
    }
  }
}

// MARK: - Beside

/// What a step did, beside its screen.
private struct StepNotes: View {
  let experiment: Replay.Experiment
  let column: Int

  var body: some View {
    let e = experiment
    let c = e.columns[column]
    let list = e.frames.filter { $0.column == column }.sorted { $0.lane < $1.lane }
    let tint = e.broke ? Theme.fail : Theme.accent
    let start = list.map(\.start).min() ?? c.start
    let end = list.map(\.end).max() ?? c.start
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        VStack(alignment: .leading, spacing: 4) {
          Text("\(Fmt.ms(start)) into the run · took \(Fmt.ms(end - start))").font(Theme.sans(11.5)).foregroundStyle(Theme.ghost)
        }
        if !c.pressure.isEmpty {
          Note(label: "Wind Tunnel pushed here") {
            ForEach(c.pressure, id: \.self) { Text($0).font(Theme.sans(13, .medium)).foregroundStyle(tint) }
          }
        }
        ForEach(Array(list.enumerated()), id: \.offset) { _, f in
          if list.count > 1 { LaneTag(experiment: e, frame: f) }
          if !f.actions.isEmpty {
            Note(label: "What the test did") {
              ForEach(Array(f.actions.enumerated()), id: \.offset) { _, a in Text(a).font(Theme.mono(12)).foregroundStyle(Theme.text) }
            }
          }
          let points = f.requests.filter { $0.method == "POINT" }
          if e.scenario != nil {
            Note(label: points.isEmpty ? "Its code reached no probe point" : "The code it reached") {
              ForEach(Array(points.enumerated()), id: \.offset) { _, p in PointLine(point: p, tint: c.pressure.isEmpty ? nil : tint) }
            }
          }
          if !f.harness.isEmpty {
            Note(label: "What Wind Tunnel did") {
              ForEach(Array(f.harness.enumerated()), id: \.offset) { _, h in Text(h).font(Theme.sans(12)).foregroundStyle(tint) }
            }
          }
          let sent = f.requests.filter { $0.method != "POINT" }
          if !sent.isEmpty {
            Note(label: "Sent") {
              ForEach(Array(sent.enumerated()), id: \.offset) { _, r in
                VStack(alignment: .leading, spacing: 3) {
                  RequestLine(request: r, tint: c.pressure.isEmpty ? nil : tint)
                  ForEach(Array(r.notes.enumerated()), id: \.offset) { _, n in Text(n).font(Theme.sans(11)).foregroundStyle(Theme.faint) }
                  if let from = r.from { Text("sent by \(from)").font(Theme.sans(11)).foregroundStyle(Theme.faint) }
                }
              }
            }
          }
          if let error = f.error {
            Note(label: "Stopped here") { Text(error).font(Theme.sans(12.5, .medium)).foregroundStyle(Theme.fail).textSelection(.enabled) }
          }
          if let text = f.text, !text.isEmpty, f.shot != nil {
            Note(label: "The page said") {
              Text(text).font(Theme.sans(11.5)).foregroundStyle(Theme.dim).lineSpacing(2).textSelection(.enabled)
            }
          }
        }
      }
      .padding(.horizontal, 20)
      .padding(.vertical, 20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.never)
  }
}

private struct Note<Content: View>: View {
  let label: String
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(label).label()
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - The end

/// What the run came to: the rules that broke and the rows that show it, why it breaks and what
/// would fix it, as the agent found it; or that every rule held.
private struct VerdictView: View {
  let experiment: Replay.Experiment
  let next: Replay.Experiment?
  let open: (String) -> Void
  let again: () -> Void
  @Environment(AppModel.self) private var model
  @State private var copied = false

  private enum Kind { case broke, error, held, notRun }

  private var kind: Kind {
    guard let run = experiment.run else { return .notRun }
    if experiment.broke { return .broke }
    return run.outcome == "error" ? .error : .held
  }

  private var tint: Color {
    switch kind {
    case .broke: Theme.fail
    case .error: Theme.error
    case .held, .notRun: Theme.dim
    }
  }

  var body: some View {
    let e = experiment
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        headline
        if kind == .error, let error = e.run?.error {
          Text(error).font(Theme.mono(12)).foregroundStyle(Theme.text).textSelection(.enabled).well(padding: 14)
        }
        ForEach(e.rules.broken, id: \.id) { rule in brokenRule(rule) }
        if let finding = e.finding {
          FindingBlock(finding: finding, tint: kind == .held ? Theme.accent : tint, held: kind == .held)
        } else if kind == .broke || kind == .error {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "questionmark.circle")
            Text("Why it breaks isn't written down yet. Once your agent reads the code behind it, it adds a `finding` to the experiment (the cause, the fix, and where), and it shows here.")
              .lineSpacing(2)
          }
          .font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
        }
        if !e.changes.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Text("What changed in the database").label()
            Text(e.changes.joined(separator: "  ·  ")).font(Theme.mono(11.5)).foregroundStyle(Theme.dim).lineSpacing(2)
          }
        }
        actions
      }
      .frame(maxWidth: 780, alignment: .leading)
      .padding(.horizontal, 40)
      .padding(.vertical, 30)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.never)
    .background(DotGrid())
  }

  private var headline: some View {
    let e = experiment
    let (icon, title, line): (String, String, String) =
      switch kind {
      case .broke:
        ("xmark", "It broke \(e.rules.broken.count == 1 ? "a rule" : "\(e.rules.broken.count) rules")",
         "After the steps, Wind Tunnel checked the app's data and found it wrong." + (e.rules.held > 0 ? " \(Fmt.plural(e.rules.held, "other rule")) held." : ""))
      case .error:
        ("exclamationmark", "It couldn't finish", "The steps stopped before the end, so the rules weren't checked.")
      case .held:
        ("checkmark", "Every rule held", "\(Fmt.plural(e.rules.held, "rule")) checked after the steps, and the app's data was right.")
      case .notRun:
        ("circle.dashed", "Not run yet", "Run it to see its steps.")
      }
    return HStack(alignment: .center, spacing: 16) {
      Image(systemName: icon)
        .font(.system(size: 20, weight: .bold))
        .foregroundStyle(kind == .held ? Theme.text : .white)
        .frame(width: 48, height: 48)
        .background(Circle().fill(kind == .held || kind == .notRun ? Theme.overlay(0.1) : tint))
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(Theme.sans(24, .semibold)).foregroundStyle(Theme.text)
        Text(line).font(Theme.sans(13)).foregroundStyle(Theme.dim)
      }
    }
  }

  private func brokenRule(_ rule: Replay.Broken) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
        Text(rule.id).font(Theme.mono(14, .medium))
      }
      .foregroundStyle(Theme.fail)
      if let d = rule.description {
        Text(d).font(Theme.sans(14)).foregroundStyle(Theme.text).lineSpacing(2)
      }
      let rows = rule.examples ?? rule.sample.map { [$0] } ?? []
      if !rows.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          Text(rule.rows == 1 ? "What it found" : "What it found (\(min(rows.count, rule.rows)) of \(rule.rows))").label()
          VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
              Text(row).font(Theme.mono(11.5)).foregroundStyle(Theme.dim).lineSpacing(2).textSelection(.enabled)
            }
          }
          .well(padding: 14)
        }
      }
    }
    .padding(.leading, 14)
    .overlay(alignment: .leading) { Rectangle().fill(Theme.fail).frame(width: 2) }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      Button(action: again) { Label("Play again", systemImage: "arrow.counterclockwise") }
        .buttonStyle(ActionButtonStyle())
      if let run = experiment.run {
        Button("Open run") {
          model.selectedRun = run.id
          model.section = .runs
        }
        .buttonStyle(ActionButtonStyle())
      }
      Button { model.runExperiments([experiment.id]) } label: { Label("Run again", systemImage: "play") }
        .buttonStyle(ActionButtonStyle())
        .disabled(model.runningJob != nil)
      if TestVerdict(experiment).failing {
        Button {
          model.copy(FixPrompt.text(experiment, file: model.experiments.first { $0.id == experiment.id }?.file, project: model.status?.project.name))
          withAnimation(Theme.snappy) { copied = true }
          Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(Theme.snappy) { copied = false }
          }
        } label: {
          Label(copied ? "Copied" : experiment.finding != nil ? "Copy fix prompt" : "Copy prompt", systemImage: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(ActionButtonStyle())
        .help("A prompt for your coding agent: what breaks, how to see it, why and where, and how to prove the fix.")
      }
      Spacer(minLength: 12)
      if let next {
        Button { open(next.id) } label: {
          HStack(spacing: 6) {
            Text("Next test")
            Text(next.id).font(Theme.mono(12)).opacity(0.7)
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
          }
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
      }
    }
    .padding(.top, 6)
  }
}

/// Why the app breaks, what would fix it, and the code to look at.
private struct FindingBlock: View {
  let finding: Replay.Finding
  let tint: Color
  /// The run held: this is what was found when it broke.
  let held: Bool
  @Environment(AppModel.self) private var model

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if held {
        Text("It broke before, for this reason; it holds now.").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      }
      part("Why it breaks", finding.cause)
      if let fix = finding.fix { part("What would fix it", fix) }
      if !finding.code.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Text("Where to look").label()
          ForEach(finding.code, id: \.self) { place in
            Button { reveal(place) } label: {
              HStack(spacing: 6) {
                Image(systemName: "doc.text").font(.system(size: 10))
                Text(place).font(Theme.mono(12))
              }
            }
            .buttonStyle(LinkButtonStyle(color: Theme.accent))
            .help("Open \(place.split(separator: ":").first.map(String.init) ?? place)")
          }
        }
      }
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Theme.radius + 2, style: .continuous).fill(tint.opacity(0.06)))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius + 2, style: .continuous).strokeBorder(tint.opacity(0.22), lineWidth: 1))
  }

  private func part(_ label: String, _ text: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).label()
      Text(text).font(Theme.sans(14)).foregroundStyle(Theme.text).lineSpacing(3).textSelection(.enabled)
    }
  }

  /// The file, in the app that opens it.
  private func reveal(_ place: String) {
    let path = String(place.split(separator: ":").first ?? Substring(place))
    guard let root = model.status?.project.repoRoot ?? model.status?.project.root ?? model.projectPath else { return }
    let url = URL(fileURLWithPath: root).appending(path: path)
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    NSWorkspace.shared.open(url)
  }
}

// MARK: - Below

/// The whole flow along the bottom: a tile per step, then the verdict, each with a bar that fills
/// as it plays. Click one to go there.
private struct FlowStrip: View {
  let experiment: Replay.Experiment
  let position: Int
  let playing: Bool
  let fraction: Double
  let go: (Int) -> Void
  let toggle: () -> Void

  var body: some View {
    let end = experiment.columns.count
    HStack(spacing: 22) {
      VStack(spacing: 8) {
        HStack(spacing: 4) {
          Button { go(0) } label: { Image(systemName: "backward.end.fill").frame(width: 22, height: 22) }
            .help("From the start")
          Button { go(position - 1) } label: { Image(systemName: "chevron.left").frame(width: 22, height: 22) }
            .help("Previous step (←)")
            .disabled(position == 0)
          Button(action: toggle) {
            Image(systemName: playing ? "pause.fill" : "play.fill")
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(Theme.ink)
              .frame(width: 40, height: 40)
              .background(Circle().fill(Theme.text.opacity(0.92)))
          }
          .help(playing ? "Pause (space)" : "Play (space)")
          Button { go(position + 1) } label: { Image(systemName: "chevron.right").frame(width: 22, height: 22) }
            .help("Next step (→)")
            .disabled(position >= end)
        }
        .buttonStyle(LinkButtonStyle(color: Theme.dim, size: 13))
        Text(position < end ? "step \(position + 1) of \(end)" : "the result")
          .font(Theme.sans(11)).foregroundStyle(Theme.faint)
      }
      .frame(width: 150)
      ScrollViewReader { proxy in
        ScrollView(.horizontal) {
          HStack(alignment: .top, spacing: 0) {
            ForEach(experiment.columns.indices, id: \.self) { c in
              FlowTile(experiment: experiment, column: c, current: c == position, fill: fill(c))
                .onTapGesture { go(c) }
                .id(c)
              FlowArrow()
            }
            VerdictTile(experiment: experiment, current: position == end, fill: position == end ? (playing ? fraction : 1) : 0)
              .onTapGesture { go(end) }
              .id(end)
          }
          .padding(.vertical, 14)
          .padding(.trailing, 20)
        }
        .scrollIndicators(.never)
        .onAppear { proxy.scrollTo(position, anchor: .center) }
        .onChange(of: position) { _, now in
          withAnimation(Theme.spring) { proxy.scrollTo(now, anchor: .center) }
        }
      }
    }
    .padding(.leading, Theme.gutter)
    .frame(height: 148)
  }

  /// How full a step's bar is: done, playing, or still to come.
  private func fill(_ c: Int) -> Double {
    if c < position { return 1 }
    if c > position { return 0 }
    return playing ? fraction : 1
  }
}

private struct FlowTile: View {
  let experiment: Replay.Experiment
  let column: Int
  let current: Bool
  let fill: Double
  @State private var hover = false

  static let width: CGFloat = 152

  var body: some View {
    let e = experiment
    let c = e.columns[column]
    let list = e.frames.enumerated().filter { $0.element.column == column }.sorted { $0.element.lane < $1.element.lane }
    let failed = list.contains { $0.element.error != nil }
    let pushed = !c.pressure.isEmpty
    let tint = e.broke ? Theme.fail : Theme.accent
    let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 2) {
        ForEach(list, id: \.offset) { _, f in
          ShotView(frame: f)
        }
      }
      .frame(width: Self.width, height: (Self.width * 10 / 16).rounded())
      .clipShape(shape)
      .overlay(shape.strokeBorder(current ? Theme.text.opacity(0.85) : failed ? Theme.fail.opacity(0.7) : Theme.line, lineWidth: current ? 2 : 1))
      .shadow(color: .black.opacity(current || hover ? 0.25 : 0.08), radius: current ? 8 : 3, y: 2)
      Bar(fill: fill, tint: current ? Theme.text.opacity(0.85) : Theme.lineStrong)
      HStack(spacing: 5) {
        Text("\(column + 1)").font(Theme.mono(10.5)).foregroundStyle(Theme.ghost)
        Text(c.step).font(Theme.mono(11.5, .medium)).foregroundStyle(current ? Theme.text : Theme.dim).lineLimit(1)
        if pushed { Circle().fill(tint).frame(width: 5, height: 5).help("Wind Tunnel pushed here: " + c.pressure.joined(separator: ", ")) }
        if failed { Image(systemName: "xmark.octagon.fill").font(.system(size: 9)).foregroundStyle(Theme.fail) }
      }
      .frame(width: Self.width, alignment: .leading)
    }
    .scaleEffect(current ? 1 : hover ? 0.99 : 0.97)
    .opacity(current || hover ? 1 : 0.8)
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .animation(Theme.snappy, value: hover)
    .animation(Theme.spring, value: current)
  }
}

private struct VerdictTile: View {
  let experiment: Replay.Experiment
  let current: Bool
  let fill: Double
  @State private var hover = false

  var body: some View {
    let e = experiment
    let error = !e.broke && e.run?.outcome == "error"
    let tint = e.broke ? Theme.fail : error ? Theme.error : Theme.dim
    let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
    VStack(alignment: .leading, spacing: 7) {
      VStack(alignment: .leading, spacing: 6) {
        Image(systemName: e.broke ? "xmark" : error ? "exclamationmark" : "checkmark").font(.system(size: 14, weight: .bold))
        Text(e.broke ? e.rules.broken.map(\.id).joined(separator: "\n") : error ? "couldn't finish" : "every rule held")
          .font(Theme.mono(11, .medium)).lineLimit(3)
      }
      .foregroundStyle(tint)
      .padding(12)
      .frame(width: 152, height: 95, alignment: .topLeading)
      .background(shape.fill(e.broke || error ? tint.opacity(0.1) : Theme.fill))
      .overlay(shape.strokeBorder(current ? Theme.text.opacity(0.85) : tint.opacity(e.broke || error ? 0.45 : 0.2), lineWidth: current ? 2 : 1))
      Bar(fill: fill, tint: current ? Theme.text.opacity(0.85) : Theme.lineStrong)
      Text("the result").font(Theme.mono(11.5, .medium)).foregroundStyle(current ? Theme.text : Theme.dim)
    }
    .frame(width: 152)
    .scaleEffect(current ? 1 : hover ? 0.99 : 0.97)
    .opacity(current || hover ? 1 : 0.85)
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .animation(Theme.snappy, value: hover)
    .animation(Theme.spring, value: current)
  }
}

private struct FlowArrow: View {
  var body: some View {
    Image(systemName: "arrow.right")
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(Theme.ghost)
      .frame(width: 30, height: 95)
  }
}

/// How far a tile has played.
private struct Bar: View {
  let fill: Double
  let tint: Color

  var body: some View {
    GeometryReader { box in
      ZStack(alignment: .leading) {
        Capsule().fill(Theme.line)
        Capsule().fill(tint).frame(width: box.size.width * fill)
      }
    }
    .frame(height: 3)
  }
}

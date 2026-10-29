import SwiftUI

/// Requests as they happen, one lane per tab or worker: each drawn at "now" while it runs, then
/// carried off to the left. Most come and go on their own. Every few seconds two run at once on
/// the same row: the stretch where both were running turns red and is caught in brackets, named
/// for the kind of bug that is.
///
/// Given `runs`, it plays back the project's recent runs instead: each sends two requests at once,
/// and the overlap is red if that run broke a rule. Holds still with Reduce Motion and while the
/// window isn't active.
struct RequestTrace: View {
  /// How far in from the right edge now is, in points: everything left of it has happened. As far
  /// in as the start screens' text is from the left, so the two sides match.
  var trailing = Double(Theme.startMargin)
  var lanes = 13
  /// The band the lanes fill, as fractions of the height.
  var top = 0.2
  var bottom = 0.8
  /// Points per second the past moves left.
  var speed = 26.0
  /// One per run, newest first, for playing back runs: whether it broke a rule.
  var runs: [Bool]? = nil
  /// Runs play back faster, for while a hunt is on.
  var busy = false
  /// A fixed time, for still renders.
  var time: Double? = nil
  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.controlActiveState) private var active

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 24, paused: time != nil || reduceMotion || active == .inactive)) { timeline in
      let t = time ?? (reduceMotion ? Self.still : Dither.clock(timeline.date))
      Canvas { context, size in
        let f = Frame(size: size, nowX: size.width - trailing, lanes: lanes, top: size.height * top, bottom: size.height * bottom, speed: speed, t: t)
        let clashes = runs.map { Self.played($0, f, busy: busy) } ?? Self.clashes(f)
        Self.draw(&context, f, spans: runs == nil ? Self.spans(f, around: clashes) : [], clashes: clashes, labelled: runs == nil, light: scheme == .light)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// A moment with a pair just caught, for Reduce Motion.
  static let still = period * 4 + 3.4

  struct Frame {
    let size: CGSize
    let nowX: Double
    let lanes: Int
    let top, bottom: Double
    let speed: Double
    let t: Double

    func x(_ time: Double) -> Double { nowX - (t - time) * speed }
    func y(_ lane: Int) -> Double { lanes > 1 ? top + (bottom - top) * Double(lane) / Double(lanes - 1) : (top + bottom) / 2 }
    /// The earliest time still on screen.
    var oldest: Double { t - nowX / speed }
  }

  struct Span {
    let lane: Int
    let from, to: Double
  }

  /// Two requests that ran at once: the second started before the first was done.
  struct Clash {
    let first, second: Span
    let label: String
    let broke: Bool

    var start: Double { first.from }
    var end: Double { max(first.to, second.to) }
    /// When both were running.
    var overlap: ClosedRange<Double> { second.from...min(first.to, second.to) }
  }

  // MARK: What happens

  static let period = 5.5
  static let labels = ["double submit", "second tab", "lost update", "webhook twice", "stale read", "retry storm"]

  /// A pair every few seconds, on lanes near each other.
  static func clashes(_ f: Frame) -> [Clash] {
    let first = Int(((f.oldest - 4) / period).rounded(.down)), last = Int((f.t / period).rounded(.down)) + 1
    return (first...last).map { m in
      let c = Double(m) * period + 2
      let a = 1 + Int(Dither.noise(m, 1, 51) * Double(max(1, f.lanes - 4)))
      let b = min(f.lanes - 1, a + 1 + Int(Dither.noise(m, 2, 51) * 2.5))
      let flip = Dither.noise(m, 3, 51) > 0.5
      return Clash(
        first: Span(lane: flip ? b : a, from: c - 0.9 - 0.5 * Dither.noise(m, 4, 51), to: c + 0.8 + 0.4 * Dither.noise(m, 5, 51)),
        second: Span(lane: flip ? a : b, from: c - 0.2, to: c + 1.5 + 0.6 * Dither.noise(m, 6, 51)),
        label: labels[((m % labels.count) + labels.count) % labels.count], broke: true)
    }
  }

  /// Runs one after another, round and round, each two requests at once on a pair of lanes.
  static func played(_ runs: [Bool], _ f: Frame, busy: Bool) -> [Clash] {
    guard !runs.isEmpty else { return [] }
    let gap = busy ? 1.3 : 2.1
    let first = Int(((f.oldest - 2) / gap).rounded(.down)), last = Int((f.t / gap).rounded(.down))
    return (first...last).map { k in
      let s = Double(k) * gap
      let a = ((k * 2) % max(1, f.lanes - 1) + max(1, f.lanes - 1)) % max(1, f.lanes - 1)
      // Oldest first, so the newest comes last before it goes round again.
      let i = ((-k - 1) % runs.count + runs.count) % runs.count
      return Clash(first: Span(lane: a, from: s, to: s + 1.1), second: Span(lane: a + 1, from: s + 0.35, to: s + 1.5), label: "", broke: runs[i])
    }
  }

  /// Everything else, a few to a lane, kept out of the way of the pairs.
  static func spans(_ f: Frame, around clashes: [Clash]) -> [Span] {
    var out: [Span] = []
    for lane in 0..<f.lanes {
      let slot = 4.2 + 2 * Dither.noise(lane, 0, 41)
      let offset = Dither.noise(lane, 1, 41) * slot
      let first = Int(((f.oldest - offset) / slot).rounded(.down)), last = Int(((f.t - offset) / slot).rounded(.down))
      for n in first...last {
        guard Dither.noise(n, lane, 42) > 0.34 else { continue }
        let start = offset + Double(n) * slot + Dither.noise(n, lane, 43) * 0.3 * slot
        let span = Span(lane: lane, from: start, to: start + (0.16 + 0.5 * Dither.noise(n, lane, 44)) * slot)
        guard span.from <= f.t else { continue }
        let busy = clashes.contains { c in
          (c.first.lane == lane || c.second.lane == lane) && span.from < c.end + 0.6 && span.to > c.start - 0.6
        }
        if !busy { out.append(span) }
      }
    }
    return out
  }

  // MARK: Drawing

  static func draw(_ context: inout GraphicsContext, _ f: Frame, spans: [Span], clashes: [Clash], labelled: Bool, light: Bool) {
    let blue = light ? Theme.accent : Theme.accentLight
    // Now: a hairline, brightest across the lanes.
    let reach = (f.bottom - f.top) * 0.18 + 20
    context.stroke(
      Path { p in p.move(to: CGPoint(x: f.nowX, y: f.top - reach)); p.addLine(to: CGPoint(x: f.nowX, y: f.bottom + reach)) },
      with: .linearGradient(
        Gradient(colors: [Theme.accent.opacity(0), Theme.accent.opacity(light ? 0.4 : 0.35), Theme.accent.opacity(0)]),
        startPoint: CGPoint(x: 0, y: f.top - reach), endPoint: CGPoint(x: 0, y: f.bottom + reach)),
      lineWidth: 1)

    // A rail for each lane, up to now.
    var rails = Path()
    for lane in 0..<f.lanes {
      rails.move(to: CGPoint(x: 0, y: f.y(lane)))
      rails.addLine(to: CGPoint(x: f.nowX, y: f.y(lane)))
    }
    context.stroke(
      rails, with: .linearGradient(Gradient(colors: [Theme.accent.opacity(0), Theme.accent.opacity(light ? 0.14 : 0.1)]), startPoint: .zero, endPoint: CGPoint(x: f.nowX, y: 0)),
      lineWidth: 0.5)

    // The past, fading the further back it is; what's still running, bright, with its head at now.
    let all = spans + clashes.flatMap { [$0.first, $0.second] }
    var past = Path(), dots = Path(), running: [Span] = []
    for s in all where s.from <= f.t {
      let x0 = f.x(s.from), x1 = f.x(min(s.to, f.t)), y = f.y(s.lane)
      guard x1 > -4 else { continue }
      if s.to > f.t { running.append(s) }
      past.move(to: CGPoint(x: x0, y: y))
      past.addLine(to: CGPoint(x: max(x0 + 0.5, x1), y: y))
      dots.addEllipse(in: CGRect(x: x0 - 1.5, y: y - 1.5, width: 3, height: 3))
    }
    let fade = Gradient(colors: [Theme.accent.opacity(light ? 0.14 : 0.1), Theme.accent.opacity(light ? 0.7 : 0.62)])
    let span = (CGPoint(x: 0, y: 0), CGPoint(x: f.nowX, y: 0))
    context.stroke(past, with: .linearGradient(fade, startPoint: span.0, endPoint: span.1), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
    context.fill(dots, with: .linearGradient(fade, startPoint: span.0, endPoint: span.1))

    // The pairs: where both ran turns red once the second starts, joined where it did, and
    // quieter as it goes, so the newest stands out.
    for c in clashes where c.broke && f.t >= c.overlap.lowerBound {
      let x0 = f.x(c.overlap.lowerBound), x1 = f.x(min(c.overlap.upperBound, f.t))
      guard x1 > -4 else { continue }
      let age = f.t - c.overlap.lowerBound
      let loud = 0.3 + 0.7 * exp(-max(0, age - 3) / 3)
      let ya = f.y(c.first.lane), yb = f.y(c.second.lane)
      var red = Path()
      for y in [ya, yb] {
        red.move(to: CGPoint(x: x0, y: y))
        red.addLine(to: CGPoint(x: max(x0 + 0.5, x1), y: y))
      }
      let fadeRed = Gradient(colors: [Theme.fail.opacity(0.3 * loud), Theme.fail.opacity(loud)])
      context.stroke(red, with: .linearGradient(fadeRed, startPoint: span.0, endPoint: span.1), style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
      context.stroke(
        Path { p in p.move(to: CGPoint(x: x0, y: min(ya, yb) + 3)); p.addLine(to: CGPoint(x: x0, y: max(ya, yb) - 3)) },
        with: .color(Theme.fail.opacity(0.55 * loud)), style: StrokeStyle(lineWidth: 1, dash: [2, 2.5]))
      if age < 0.8 {
        let k = age / 0.8
        for y in [ya, yb] { flash(&context, at: CGPoint(x: f.nowX, y: y), radius: 6 + 18 * k, strength: 0.6 * (1 - k)) }
      }
      if labelled { catchBox(&context, c, f, age: age) }
    }

    for s in running {
      let at = CGPoint(x: f.nowX, y: f.y(s.lane))
      let clashing = clashes.contains { c in c.broke && f.t >= c.overlap.lowerBound && f.t <= c.overlap.upperBound && (c.first.lane == s.lane || c.second.lane == s.lane) && (c.first.from == s.from || c.second.from == s.from) }
      let color = clashing ? Theme.fail : blue
      // The stretch just drawn, brighter.
      let x0 = max(f.x(s.from), f.nowX - 40)
      context.stroke(
        Path { p in p.move(to: CGPoint(x: x0, y: at.y)); p.addLine(to: at) },
        with: .linearGradient(Gradient(colors: [color.opacity(0), color.opacity(0.9)]), startPoint: CGPoint(x: f.nowX - 40, y: 0), endPoint: CGPoint(x: f.nowX, y: 0)),
        style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
      let r = 8.0
      context.fill(
        Path(ellipseIn: CGRect(x: at.x - r, y: at.y - r, width: 2 * r, height: 2 * r)),
        with: .radialGradient(Gradient(colors: [color.opacity(light ? 0.3 : 0.4), color.opacity(0)]), center: at, startRadius: 0, endRadius: r))
      context.fill(Path(ellipseIn: CGRect(x: at.x - 2, y: at.y - 2, width: 4, height: 4)), with: .color(color))
    }
  }

  static func flash(_ context: inout GraphicsContext, at p: CGPoint, radius r: Double, strength: Double) {
    context.fill(
      Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: 2 * r, height: 2 * r)),
      with: .radialGradient(Gradient(colors: [Theme.fail.opacity(strength), Theme.fail.opacity(0)]), center: p, startRadius: 0, endRadius: r))
  }

  /// Brackets that close on where both ran, and its name, for a few seconds after.
  static func catchBox(_ context: inout GraphicsContext, _ c: Clash, _ f: Frame, age: Double) {
    guard age < 5 else { return }
    let life = age < 3.8 ? 1 : 1 - (age - 3.8) / 1.2
    let lock = min(1, age / 0.6)
    let eased = lock * lock * (3 - 2 * lock)
    let x0 = f.x(c.overlap.lowerBound), x1 = f.x(min(c.overlap.upperBound, f.t))
    let ya = f.y(c.first.lane), yb = f.y(c.second.lane)
    let pad = 9 + 14 * (1 - eased)
    let box = CGRect(x: x0 - pad, y: min(ya, yb) - pad, width: max(0, x1 - x0) + 2 * pad, height: abs(yb - ya) + 2 * pad)
    let arm = 5.0
    var brackets = Path()
    for (corner, sx, sy) in [
      (CGPoint(x: box.minX, y: box.minY), 1.0, 1.0), (CGPoint(x: box.maxX, y: box.minY), -1, 1),
      (CGPoint(x: box.minX, y: box.maxY), 1, -1), (CGPoint(x: box.maxX, y: box.maxY), -1, -1),
    ] {
      brackets.move(to: CGPoint(x: corner.x, y: corner.y + sy * arm))
      brackets.addLine(to: corner)
      brackets.addLine(to: CGPoint(x: corner.x + sx * arm, y: corner.y))
    }
    context.stroke(brackets, with: .color(Theme.fail.opacity(life * (0.4 + 0.6 * eased))), style: StrokeStyle(lineWidth: 1.25, lineCap: .square))
    if age > 0.4 {
      let shown = min(1, (age - 0.4) / 0.3) * life
      let label = context.resolve(Text(c.label).font(Theme.mono(10, .medium)).foregroundStyle(Theme.fail.opacity(shown)))
      // Over the brackets, but never past now's side of them.
      let width = label.measure(in: CGSize(width: 400, height: 40)).width
      context.draw(label, at: CGPoint(x: min(box.minX, f.nowX + 9 - width), y: box.minY - 5), anchor: .bottomLeading)
    }
  }
}

/// Where the start screens' trace shows: not behind the text on the left, fully on the right,
/// softly off at the top and bottom edges. For `.mask`.
struct StartScreenFade: View {
  var body: some View {
    LinearGradient(stops: [.init(color: .clear, location: 0.38), .init(color: .black, location: 0.66)], startPoint: .leading, endPoint: .trailing)
      .mask(
        LinearGradient(
          stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.12), .init(color: .black, location: 0.88), .init(color: .clear, location: 1)],
          startPoint: .top, endPoint: .bottom))
  }
}

import SwiftUI

/// Characters drawn like a shader. Each cell of a monospaced grid asks a scene for a glyph and how
/// bright it is; the field is then coloured through a gradient, with its brightest cells lit white
/// on top, so it reads as one lit object rather than as text. It steps at a low frame rate, which
/// is how ASCII looks right, and holds still when Reduce Motion is on.
struct AsciiArt: View {
  let scene: AsciiScene
  var fontSize: CGFloat = 10
  /// Row height as a multiple of the font size: tight, so the field reads as an image.
  var lineHeight: CGFloat = 1.08
  var colors: [Color] = Theme.hue
  var fps: Double = 20
  /// A fixed time, for still renders.
  var time: Double? = nil
  var paused = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geo in
      TimelineView(.animation(minimumInterval: 1 / fps, paused: paused || time != nil || reduceMotion)) { timeline in
        let t = time ?? (reduceMotion ? 8 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 3600))
        let frame = AsciiFrame(scene: scene, size: geo.size, fontSize: fontSize, lineHeight: lineHeight, t: t)
        ZStack {
          LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing)
            .mask { Canvas { context, _ in frame.draw(&context, frame.base) } }
          Canvas { context, _ in frame.draw(&context, frame.lights) }
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// What to draw: for a point (in points from the top left of a field of `size`) at time `t`,
/// a glyph and its brightness from 0 to 1, or nil for empty air.
struct AsciiScene {
  struct Context {
    let size: CGSize
    let t: Double
    /// One cell, in points.
    let cell: CGSize
  }

  let cell: (_ x: Double, _ y: Double, _ c: Context) -> (Character, Double)?
}

/// One frame: the field's rows, split by brightness so each level draws as one string.
struct AsciiFrame {
  static let levels = 10
  let font: Font
  let ch: Double
  /// [level][row]: the glyphs at that brightness, spaces elsewhere (nil when the row has none).
  var base: [[String?]]
  /// The brightest cells again, drawn white over the colour.
  var lights: [[String?]]

  init(scene: AsciiScene, size: CGSize, fontSize: CGFloat, lineHeight: CGFloat, t: Double) {
    font = .system(size: fontSize, weight: .regular, design: .monospaced)
    let cw = Double(fontSize) * 0.6021
    ch = Double(fontSize * lineHeight)
    let cols = max(1, Int(Double(size.width) / cw))
    let rows = max(1, Int(Double(size.height) / ch))
    let blank = [Character](repeating: " ", count: cols)
    let context = AsciiScene.Context(size: size, t: t, cell: CGSize(width: cw, height: ch))
    var base = [[[Character]?]](repeating: [[Character]?](repeating: nil, count: rows), count: Self.levels + 1)
    var lights = [[[Character]?]](repeating: [[Character]?](repeating: nil, count: rows), count: 4)
    for row in 0..<rows {
      let y = (Double(row) + 0.5) * ch
      for col in 0..<cols {
        guard let (glyph, b) = scene.cell((Double(col) + 0.5) * cw, y, context), b > 0.02, glyph != " " else { continue }
        let level = min(Self.levels, max(1, Int((b * Double(Self.levels)).rounded(.up))))
        if base[level][row] == nil { base[level][row] = blank }
        base[level][row]![col] = glyph
        if b > 0.8 {
          let l = min(3, Int((b - 0.8) / 0.2 * 3) + 1)
          if lights[l][row] == nil { lights[l][row] = blank }
          lights[l][row]![col] = glyph
        }
      }
    }
    self.base = base.map { $0.map { $0.map { String($0) } } }
    self.lights = lights.map { $0.map { $0.map { String($0) } } }
  }

  func draw(_ context: inout GraphicsContext, _ layers: [[String?]]) {
    let top = layers.count - 1
    guard top > 0 else { return }
    for level in 1...top {
      // Base levels ramp up to full ink; the white highlight stays a glaze.
      let opacity = layers.count > 4
        ? 0.1 + 0.9 * pow(Double(level) / Double(top), 1.35)
        : 0.22 * Double(level)
      for (row, line) in layers[level].enumerated() {
        guard let line else { continue }
        context.draw(
          Text(line).font(font).foregroundStyle(Color.white.opacity(opacity)),
          at: CGPoint(x: 0, y: Double(row) * ch), anchor: .topLeading)
      }
    }
  }
}

// MARK: - Scenes

extension AsciiScene {
  /// Air through a wind tunnel's test section, seen from the side. Smoke lines run left to right,
  /// squeeze together through the narrow throat and speed up there, then spread out behind it and
  /// start to waver: steady flow turning unsteady, which is what the app looks for. Puffs of smoke
  /// travel down each line and specks of dust drift between them.
  /// `throat`: where the narrowest point is, as a fraction of the width. `squeeze`: how much
  /// narrower the channel is there. `spacing`: rows between lines at the inlet. `probe`: a sensor
  /// sweeping along the section, for while something is searching.
  static func tunnel(
    throat: Double = 0.5, squeeze: Double = 0.5, spacing: Double = 3.2, walls: Bool = true, dust: Bool = true,
    probe: Bool = false, speed: Double = 1
  ) -> AsciiScene {
    AsciiScene { px, py, c in
      tunnelCell(px, py, c, throat: throat, squeeze: squeeze, spacing: spacing, walls: walls, dust: dust, probe: probe, speed: speed)
    }
  }

  private static func tunnelCell(
    _ px: Double, _ py: Double, _ c: Context,
    throat: Double, squeeze: Double, spacing: Double, walls: Bool, dust: Bool, probe: Bool, speed: Double
  ) -> (Character, Double)? {
    let sigma = 0.16
    let W = Double(c.size.width), H = Double(c.size.height)
    let cw = Double(c.cell.width), ch = Double(c.cell.height)
    // The channel's half-height at the inlet, and y across it from -1 (top) to 1 (bottom).
    let half = H / 2 * 0.92
    let x = px / W
    let y = (py - H / 2) / half
    let rowsPerUnit = half / ch
    let t = c.t * speed
    let n = max(3, Int(2 * rowsPerUnit / spacing) | 1)
    let gap = 2 / Double(n)
    func width(_ x: Double) -> Double { 1 - squeeze * exp(-pow((x - throat) / sigma, 2)) }
    // None before the throat, growing behind it.
    func unsteady(_ x: Double) -> Double { smoothstep(throat + 0.04, throat + 0.48, x) }
    func lineY(_ k: Int, _ x: Double) -> Double {
      let s = -1 + (2 * Double(k) + 1) / Double(n)
      let u = unsteady(x)
      guard u > 0 else { return s * width(x) }
      let kk = Double(k)
      // Neighbouring lines move almost together, like a ribbon, so the bundle waves as one.
      let wave: Double = 0.75 * sin(x * 12 - t * 1.1 + kk * 0.42) + 0.25 * sin(x * 26 - t * 1.9 + kk * 0.9)
      let spread: Double = 0.4 * (0.6 + 0.4 * abs(s))
      return s * width(x) + u * gap * wave * spread
    }
    let w = width(x)
    let fade = smoothstep(0, 0.07, x) * smoothstep(1, 0.93, x)
    guard fade > 0 else { return nil }
    // Time of flight from the inlet (the integral of the channel width): the air runs faster
    // where the channel is narrow, so puffs speed up through the throat and stretch out.
    let tau: Double = x - squeeze * sigma * 0.8862 * (erf((x - throat) / sigma) + erf(throat / sigma))
    var sensor = 0.0
    if probe {
      let sweep = (t * 0.085).truncatingRemainder(dividingBy: 1) * 1.3 - 0.15
      let d: Double = (x - sweep) * W / (cw * 1.4)
      sensor = exp(-d * d)
    }

    // The nearest smoke line, if it passes through this cell.
    let near = Int(((y / w + 1) * Double(n) / 2 - 0.5).rounded())
    var best: (k: Int, off: Double, slope: Double)?
    for k in (near - 1)...(near + 1) where k >= 0 && k < n {
      // How far the line is from the middle of this cell, in rows (+ is below), and its slope
      // in rows per column.
      let off = (lineY(k, x) - y) * rowsPerUnit
      let e = 0.004
      let slope = (lineY(k, x + e) - lineY(k, x - e)) / (2 * e) * rowsPerUnit * cw / W
      if abs(off) < 0.5 + min(1.2, abs(slope) * 0.5), abs(off) < abs(best?.off ?? .infinity) {
        best = (k, off, slope)
      }
    }
    if let (k, off, slope) = best {
      // A bright head, a tail fading back upstream, clear air between.
      let phase = tau * 3.1 - t * 0.3 + Double((k * 7919) % 13) * 0.137
      let f = phase - floor(phase)
      let puff = f > 0.52 ? pow((f - 0.52) / 0.48, 2.6) : 0
      let squeezed = 0.2 * (1 - w) / max(0.01, squeeze)
      let v = (0.3 + squeezed + 0.7 * puff + 0.45 * sensor) * fade
      return (stroke(slope: slope, off: off), min(1, v))
    }

    let col = Int(px / cw)
    // The walls: a dotted contour just outside the outer lines.
    if walls {
      let wall = (abs(y) - w - gap * 0.5) * rowsPerUnit
      if abs(wall) < 0.5 {
        return (col % 2 == 0 ? "·" : " ", (0.2 + 0.3 * sensor) * fade)
      }
    }
    guard abs(y) < w else { return nil }
    if sensor > 0.75 {
      return ("|", 0.22 * sensor * fade)
    }
    // Dust, drifting between the lines with the air.
    if dust {
      let m = ((y / w + 1) / gap).rounded()
      let off = ((-1 + m * gap) * w - y) * rowsPerUnit
      if m >= 1, m < Double(n), abs(off) < 0.5 {
        let q = (tau - t * 0.1) * 120
        if hash(Int(q.rounded(.down)), Int(m)) < 0.07 {
          return ("·", (0.16 + 0.4 * sensor) * fade)
        }
      }
    }
    return nil
  }
}

/// A character for a line through a cell: a slash where it climbs or falls steeply (`slope` in rows
/// per column, screen y down), else a low, middle or high stroke for where it crosses (`off` in
/// rows from the middle, + is below).
private func stroke(slope: Double, off: Double) -> Character {
  if slope < -0.62 { return "/" }
  if slope > 0.62 { return "\\" }
  if off > 0.2 { return "_" }
  if off < -0.2 { return "¯" }
  return "-"
}

/// A repeatable pseudo-random number from 0 to 1 for a pair of integers.
private func hash(_ a: Int, _ b: Int) -> Double {
  var h = UInt64(bitPattern: Int64(a &* 374_761_393 &+ b &* 668_265_263))
  h = (h ^ (h >> 13)) &* 1_274_126_177
  h ^= h >> 16
  return Double(h & 0xFFFF) / 65535
}

private func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

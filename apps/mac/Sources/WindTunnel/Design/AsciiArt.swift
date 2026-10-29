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
  var colors: [Color] = Theme.asciiGradient
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
          LinearGradient(colors: colors, startPoint: .topLeading, endPoint: .bottomTrailing)
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
  static let sphereRamp: [Character] = Array(" .·:-=+*#%@")

  /// A lit sphere in a stream of air: its surface banded and slowly turning; smoke lines bend
  /// over and under it, pulse downstream, and roll up into a vortex street in its wake.
  /// `center` is a fraction of the size, `radius` a fraction of the height.
  static func orb(center: UnitPoint = .center, radius: Double = 0.3, flow: Bool = true, speed: Double = 1) -> AsciiScene {
    AsciiScene { px, py, c in
      let R = max(8, radius * Double(c.size.height))
      let x = (px - Double(c.size.width) * center.x) / R
      let y = (py - Double(c.size.height) * center.y) / R
      let d2 = x * x + y * y
      let dither = bayer(Int(px / Double(c.cell.width)), Int(py / Double(c.cell.height)))
      if d2 < 1 { return sphere(x, y, d2, c.t * speed, dither: dither) }
      guard flow else { return halo(d2, dither: dither) }
      return air(x, y, d2, c.t * speed, rowHeight: Double(c.cell.height) / R, dither: dither)
    }
  }

  private static func sphere(_ x: Double, _ y: Double, _ d2: Double, _ t: Double, dither: Double) -> (Character, Double) {
    let z = (1 - d2).squareRoot()
    // Key light from the upper left and in front; a cool rim from behind on the lower right.
    let diffuse = max(0, -0.5 * x - 0.6 * y + 0.62 * z)
    let rim = pow(1 - z, 2.4) * max(0, 0.6 * x + 0.4 * y + 0.2) * 0.7
    // A faint weather on the surface, on an axis tilted off the rows, turning slowly.
    let a = t * 0.2
    let (ty, tz) = (y * 0.94 - z * 0.34, y * 0.34 + z * 0.94)
    let X = x * cos(a) + tz * sin(a)
    let Z = -x * sin(a) + tz * cos(a)
    let lon = atan2(X, Z)
    let lat = asin(max(-1, min(1, ty)))
    let weather = 0.5 + 0.5 * sin(lat * 6 + 1.3 * sin(lon * 2 + lat * 2.5) + 0.5 * sin(lon * 5 - lat * 3))
    let v = min(1, 0.04 + 0.94 * pow(diffuse, 1.2) * (0.84 + 0.16 * weather) + rim)
    // Ordered dithering between neighbouring glyphs, so the shading reads as a smooth gradient
    // instead of a stack of rows.
    let ramp = sphereRamp
    let steps = Double(ramp.count - 1)
    let glyph = ramp[max(1, min(ramp.count - 1, Int(v * steps + dither)))]
    return (glyph, 0.2 + 0.8 * v)
  }

  /// A thin atmosphere just outside the body, in fine dithered dots.
  private static func halo(_ d2: Double, dither: Double) -> (Character, Double)? {
    let glow = exp(-(d2.squareRoot() - 1) * 7) * 0.5
    guard glow > 0.04, glow > dither * 0.5 else { return nil }
    return (glow > 0.3 ? ":" : "·", glow)
  }

  /// Stream function (in units of the radius): uniform flow round a cylinder, plus vortices shed
  /// alternately above and below the wake and drifting downstream.
  private static func psi(_ x: Double, _ y: Double, _ t: Double) -> Double {
    let r2 = max(x * x + y * y, 1)
    var value = y * (1 - 1 / r2)
    // The wake only matters behind the body; fade it in smoothly so the field has no seam.
    let behind = smoothstep(-1.2, 0.6, x)
    guard behind > 0 else { return value }
    let spacing = 2.4
    let g = (t * 0.45 / spacing).truncatingRemainder(dividingBy: 2)
    for k in 0...6 {
      let vx = 0.8 + spacing * (Double(k) + g - 1)
      if vx < 0.8 { continue }
      let sign: Double = k % 2 == 0 ? 1 : -1
      let vy = sign * (0.45 + 0.025 * vx)
      let grow = smoothstep(0.8, 0.8 + spacing, vx)
      let strength = 2.6 * grow * exp(-(vx - 1) / 9)
      let d2 = (x - vx) * (x - vx) + (y - vy) * (y - vy)
      value += behind * sign * strength / (4 * .pi) * log(d2 + 0.22)
    }
    return value
  }

  private static func air(_ x: Double, _ y: Double, _ d2: Double, _ t: Double, rowHeight: Double, dither: Double) -> (Character, Double)? {
    // The air shows near the body and fades out, reaching further downstream.
    let ex = x < 0 ? x / 2.1 : x / 3.6
    let ey = y / (x < 0 ? 1.55 : 1.4 + 0.1 * max(0, x))
    let envelope = exp(-(ex * ex + ey * ey))
    let atmosphere = halo(d2, dither: dither)
    guard envelope > 0.05 else { return atmosphere }
    let p = psi(x, y, t)
    let spacing = 0.42
    let u = p / spacing
    let e = 0.02
    let gx = (psi(x + e, y, t) - psi(x - e, y, t)) / (2 * e)
    let gy = (psi(x, y + e, t) - psi(x, y - e, t)) / (2 * e)
    let grad = max(0.15, (gx * gx + gy * gy).squareRoot())
    // Distance to the nearest smoke line, against about half a row.
    let dist = abs(u - u.rounded()) * spacing / grad
    let ribbon = exp(-pow(dist / (0.48 * rowHeight), 2))
    guard ribbon > 0.15 else { return atmosphere }
    // Puffs travel downstream, faster where the air is fast: a bright head and a fading tail,
    // with clear air between them.
    let r2 = max(d2, 1)
    let phi = x * (1 + 1 / r2)
    let s = phi * 0.36 - t * 0.5 + u.rounded() * 0.43
    let f = s - floor(s)
    guard f < 0.62 else { return atmosphere }
    let pulse = pow(1 - f / 0.62, 1.6)
    let v = ribbon * envelope * (0.15 + 0.85 * pulse)
    guard v > 0.06 else { return atmosphere }
    // The glyph follows the line where it bends hard (screen y points down).
    let slope = gy == 0 ? 0 : -gx / gy
    let glyph: Character
    if v < 0.14 { glyph = "·" }
    else if slope < -0.55 { glyph = "/" }
    else if slope > 0.55 { glyph = "\\" }
    else { glyph = f < 0.08 && v > 0.4 ? "=" : "-" }
    return (glyph, min(1, v * 1.15))
  }

  /// A radar sweep: dotted rings, a beam with a dithered afterglow behind it, and a few blips
  /// that flare as the beam finds them and fade after it.
  static func scan(center: UnitPoint = .center, radius: Double = 0.42, speed: Double = 1) -> AsciiScene {
    let blips: [(Double, Double)] = [(0.64, 0.7), (0.4, 2.3), (0.83, 3.6), (0.55, 5.0)]
    return AsciiScene { px, py, c in
      let R = max(8, radius * Double(c.size.height))
      let x = (px - Double(c.size.width) * center.x) / R
      let y = (py - Double(c.size.height) * center.y) / R
      let r = (x * x + y * y).squareRoot()
      guard r <= 1.06 else { return nil }
      let dither = bayer(Int(px / Double(c.cell.width)), Int(py / Double(c.cell.height)))
      let theta = atan2(y, x)
      let beam = (c.t * 0.8 * speed).truncatingRemainder(dividingBy: 2 * .pi)
      func behind(_ angle: Double) -> Double {
        let lag = beam - angle
        return lag - 2 * .pi * floor(lag / (2 * .pi))
      }
      let lag = behind(theta)
      let cellR = Double(c.cell.height) / R
      let halfW = Double(c.cell.width) / 2 / R
      let halfH = Double(c.cell.height) / 2 / R
      for (br, ba) in blips {
        let dx = abs(x - br * cos(ba)), dy = abs(y - br * sin(ba))
        if dx < halfW * 3, dy < halfH {
          let glow = exp(-behind(ba) * 0.45)
          guard glow > 0.06 else { break }
          return dx < halfW ? ("@", 0.25 + 0.75 * glow) : ("·", 0.15 + 0.5 * glow)
        }
      }
      // The beam: a line out from the centre, its glyph along its angle (screen y points down).
      let across = r * sin(min(lag, 2 * .pi - lag)) * R
      if r > 0.05, r < 1, lag < 1 || lag > 2 * .pi - 0.2, across < Double(c.cell.width) * 0.62 {
        let slope = tan(beam)
        let glyph: Character = abs(slope) < 0.3 ? "-" : abs(slope) > 2.5 ? "|" : slope > 0 ? "\\" : "/"
        return (glyph, 0.5 + 0.5 * r)
      }
      let ring = abs(r * 4 - (r * 4).rounded()) * 0.25 < cellR * 0.32 && r > 0.15
      // The afterglow: dense just behind the beam, thinning out over a quarter turn.
      let glow = r < 1 ? pow(max(0, 1 - lag / 2.2), 1.8) * (0.55 + 0.45 * r) : 0
      if glow > 0.05, glow > dither * 0.85 {
        return (ring ? "+" : glow > 0.55 ? ":" : "·", 0.12 + 0.8 * glow)
      }
      if ring { return ("·", 0.2) }
      // Faint cross hairs.
      if r < 1, abs(x) < cellR * 0.25 || abs(y) < cellR * 0.5, (Int(px / Double(c.cell.width)) + Int(py / Double(c.cell.height))) % 2 == 0 {
        return ("·", 0.1)
      }
      return nil
    }
  }
}

/// A 4×4 Bayer threshold for a cell, from 0 to 1.
private func bayer(_ col: Int, _ row: Int) -> Double {
  let m = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
  return (Double(m[(row & 3) * 4 + (col & 3)]) + 0.5) / 16
}

private func smoothstep(_ a: Double, _ b: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

import SwiftUI

/// Air flowing past a cylinder, drawn in characters the way smoke shows it in a real wind tunnel:
/// thin streaks along the streamlines of potential flow, bending round the obstacle, then rolling
/// up into a Kármán vortex street behind it. Each cell's character comes from how close it is to
/// a streamline (a density ramp, so curves read smoothly), and puffs travel along the streaks,
/// faster where the air speeds up.
struct AirflowField: View {
  var fontSize: CGFloat = 11
  var color: Color = Theme.accent
  /// Obstacle centre, as a fraction of the size.
  var center = CGPoint(x: 0.28, y: 0.5)
  /// Obstacle radius as a fraction of the height.
  var radius: CGFloat = 0.2
  /// Streaks across the height.
  var lines: Double = 12
  var speed: Double = 1
  /// Whether to draw the obstacle (off: plain streaks, for backgrounds).
  var obstacle = true
  var paused = false
  /// Fixed time, for still renders.
  var time: Double? = nil

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: paused || time != nil)) { timeline in
      let t = time ?? timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000)
      Canvas(rendersAsynchronously: true) { context, size in
        let field = AirflowGrid(size: size, fontSize: fontSize, center: center, radius: radius, lines: lines, obstacle: obstacle)
        field.draw(in: &context, t: t * speed, color: color, fontSize: fontSize)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

struct AirflowGrid {
  let cols: Int
  let rows: Int
  let cw: Double
  let ch: Double
  let cx: Double
  let cy: Double
  let r: Double
  let step: Double
  let obstacle: Bool

  init(size: CGSize, fontSize: CGFloat, center: CGPoint, radius: CGFloat, lines: Double, obstacle: Bool) {
    cw = Double(fontSize) * 0.6021
    ch = Double(fontSize) * 1.3
    cols = max(1, Int(Double(size.width) / cw))
    rows = max(1, Int(Double(size.height) / ch))
    cx = Double(size.width * center.x)
    cy = Double(size.height * center.y)
    r = Double(max(10, size.height * radius))
    step = Double(size.height) / r / lines
    self.obstacle = obstacle
  }

  /// Stream function at a point (in units of the radius): uniform flow round a cylinder, plus
  /// vortices shed alternately above and below the wake, drifting downstream.
  func psi(_ x: Double, _ y: Double, _ t: Double) -> Double {
    let rr = max(x * x + y * y, 1)
    var value = obstacle ? y * (1 - 1 / rr) : y
    guard obstacle else { return value + 0.08 * sin(x * 0.9 - t * 0.7) * sin(y * 1.3 + t * 0.4) }
    let spacing = 2.6
    let g = (t * 0.5 / spacing).truncatingRemainder(dividingBy: 2)
    for k in 0...9 {
      let vx = 0.7 + spacing * (Double(k) + g - 1)
      if vx < 0.7 { continue }
      let sign: Double = k % 2 == 0 ? 1 : -1
      // Shed close behind the cylinder, then drift outwards a little and weaken.
      let vy = sign * (0.42 + 0.03 * vx)
      let grow = smooth(0.7, 0.7 + spacing * 1.1, vx)
      let strength = 3.4 * grow * exp(-(vx - 1) / 16)
      let d2 = (x - vx) * (x - vx) + (y - vy) * (y - vy)
      // A core of finite size, so the streaks curl instead of collapsing to a point.
      value += sign * strength / (4 * .pi) * log(d2 + 0.18)
    }
    return value
  }

  /// Velocity potential, for spacing puffs along the streaks.
  func phi(_ x: Double, _ y: Double) -> Double {
    guard obstacle else { return x }
    let rr = max(x * x + y * y, 1)
    return x * (1 + 1 / rr)
  }

  static let ramp: [Character] = [" ", "·", "-", "~", "=", "≈"]
  static let solidRamp: [Character] = Array(" .:-=+*#%@")

  func draw(in context: inout GraphicsContext, t: Double, color: Color, fontSize: CGFloat) {
    let font = Theme.mono(fontSize)
    let levels = 4
    let e = 0.03
    var layers = [[[Character]]](repeating: [[Character]](repeating: [Character](repeating: " ", count: cols), count: rows), count: levels + 1)
    var solid = [[Character]](repeating: [Character](repeating: " ", count: cols), count: rows)
    var any = [Bool](repeating: false, count: rows)
    var anySolid = [Bool](repeating: false, count: rows)

    for row in 0..<rows {
      for col in 0..<cols {
        let x = ((Double(col) + 0.5) * cw - cx) / r
        let y = ((Double(row) + 0.5) * ch - cy) / r
        let d = (x * x + y * y).squareRoot()
        if obstacle && d < 1.04 {
          if let c = shade(x, y, d) {
            solid[row][col] = c
            anySolid[row] = true
          }
          continue
        }
        let p = psi(x, y, t)
        let gx = (psi(x + e, y, t) - psi(x - e, y, t)) / (2 * e)
        let gy = (psi(x, y + e, t) - psi(x, y - e, t)) / (2 * e)
        let speed = max(0.05, (gx * gx + gy * gy).squareRoot())
        // Behind the cylinder the streaks pack closer, so the shed vortices show as curls.
        let wake = obstacle ? exp(-max(0, abs(y) - 0.35) * max(0, abs(y) - 0.35) * 5) * smooth(-0.3, 1.2, x) : 0
        let local = step * (1 - 0.62 * wake)
        // Distance to the nearest streak, in cell heights.
        let u = p / local
        let off = abs(u - u.rounded()) * local / speed * r / ch
        let streak = max(0, 1 - off / 0.8)
        guard streak > 0.05 else { continue }
        // Pulses of brighter smoke travel downstream, faster where the air speeds up.
        let s = phi(x, y) * 0.9 - t * 1.6 + u.rounded() * 0.31
        let f = s - floor(s)
        let pulse = 0.5 + 0.5 * pow(max(0, 1 - f / 0.55), 1.4) + (f > 0.8 ? 0.12 : 0)
        let value = streak * pulse * min(1.3, 0.6 + 0.35 * speed) * (1 - 0.25 * wake)
        let index = min(Self.ramp.count - 1, Int(value * Double(Self.ramp.count - 1) + 0.45))
        guard index > 0 else { continue }
        let level = min(levels, max(1, Int(value * Double(levels) + 0.5)))
        layers[level][row][col] = Self.ramp[index]
        any[row] = true
      }
    }
    for l in 1...levels {
      let opacity = 0.16 + 0.84 * pow(Double(l) / Double(levels), 1.5)
      for row in 0..<rows where any[row] {
        let line = String(layers[l][row])
        if line.allSatisfy({ $0 == " " }) { continue }
        context.draw(
          Text(line).font(font).foregroundStyle(color.opacity(opacity)),
          at: CGPoint(x: 0, y: Double(row) * ch), anchor: .topLeading)
      }
    }
    for row in 0..<rows where anySolid[row] {
      context.draw(
        Text(String(solid[row])).font(font).foregroundStyle(Theme.text.opacity(0.85)),
        at: CGPoint(x: 0, y: Double(row) * ch), anchor: .topLeading)
    }
  }

  /// The cylinder as a lit sphere of characters, light from the upper left.
  private func shade(_ x: Double, _ y: Double, _ d: Double) -> Character? {
    if d > 1 { return "." }
    let z = max(0, 1 - d * d).squareRoot()
    let (lx, ly, lz) = (-0.55, -0.62, 0.56)
    let diffuse = max(0, x * lx + y * ly + z * lz)
    let rim = pow(1 - z, 3) * 0.25
    let v = min(1, diffuse * 0.95 + rim + 0.06)
    let ramp = Self.solidRamp
    return ramp[max(1, min(ramp.count - 1, Int(v * Double(ramp.count - 1) + 0.5)))]
  }
}

private func smooth(_ a: Double, _ b: Double, _ x: Double) -> Double {
  let t = min(1, max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

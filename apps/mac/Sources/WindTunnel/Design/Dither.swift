import SwiftUI
import simd

// MARK: - The engine

/// A picture made of square cells, each off or lit at one of three strengths, picked by ordered
/// (Bayer) dithering: soft values become a fine, even texture instead of a blur. One pixel per
/// cell, drawn scaled up without smoothing, so the cells stay crisp at any size.
struct DitherFrame {
  struct Ink {
    let r, g, b: Float
    /// Opacity at full strength.
    let alpha: Float

    init(_ hex: UInt32, _ alpha: Float) {
      r = Float((hex >> 16) & 0xFF) / 255
      g = Float((hex >> 8) & 0xFF) / 255
      b = Float(hex & 0xFF) / 255
      self.alpha = alpha
    }
  }

  let width: Int
  let height: Int
  /// Points per cell.
  let cell: Double
  private let inks: [Ink]
  private var bytes: [UInt8]

  init(width: Int, height: Int, cell: Double, inks: [Ink]) {
    self.width = width
    self.height = height
    self.cell = cell
    self.inks = inks
    bytes = [UInt8](repeating: 0, count: width * height * 4)
  }

  /// The frame's size in points.
  var size: SIMD2<Double> { SIMD2(Double(width), Double(height)) * cell }

  /// The centre of cell (x, y), in points.
  @inline(__always) func point(_ x: Int, _ y: Int) -> SIMD2<Double> {
    SIMD2((Double(x) + 0.5) * cell, (Double(y) + 0.5) * cell)
  }

  /// Lights cell (x, y) with `value` (0…1) of an ink. A later call on the same cell wins, unless
  /// it dithers to nothing there.
  @inline(__always) mutating func put(_ x: Int, _ y: Int, _ value: Double, ink: Int = 0) {
    put(x, y, Float(value), ink: ink)
  }

  @inline(__always) mutating func put(_ x: Int, _ y: Int, _ value: Float, ink: Int = 0) {
    guard value > 0.004, x >= 0, y >= 0, x < width, y < height else { return }
    let s = min(value, 1) * 3
    let whole = Int(s)
    let level = min(3, whole + (s - Float(whole) > Self.bayer[(y & 7) << 3 | (x & 7)] ? 1 : 0))
    guard level > 0 else { return }
    let ink = inks[ink]
    let a = Self.strength[level] * ink.alpha
    let i = (y * width + x) * 4
    bytes[i] = UInt8(ink.r * a * 255)
    bytes[i + 1] = UInt8(ink.g * a * 255)
    bytes[i + 2] = UInt8(ink.b * a * 255)
    bytes[i + 3] = UInt8(a * 255)
  }

  func image() -> CGImage? {
    guard let provider = CGDataProvider(data: Data(bytes) as CFData), let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    return CGImage(
      width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: space,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
      shouldInterpolate: false, intent: .defaultIntent)
  }

  /// Off, faint, mid, full.
  private static let strength: [Float] = [0, 0.32, 0.62, 1]

  /// The 8×8 Bayer matrix as thresholds in 0..<1.
  private static let bayer: [Float] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26,
    12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
    3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25,
    15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ].map { (Float($0) + 0.5) / 64 }
}

enum Dither {
  /// Seconds since the app started, a few in, so scenes are already moving when they appear.
  static func clock(_ date: Date) -> Double { date.timeIntervalSince(started) + 3 }
  private static let started = Date()

  /// The same noise in 0..<1 for the same three numbers.
  @inline(__always) static func noise(_ x: Int, _ y: Int, _ seed: Int) -> Double {
    var h = UInt32(truncatingIfNeeded: x &* 374_761_393 &+ y &* 668_265_263 &+ seed &* 1_274_126_177)
    h = (h ^ (h >> 13)) &* 1_274_126_177
    return Double(h ^ (h >> 16)) / Double(UInt32.max)
  }

  /// The two inks every scene uses: the hue, and red for what broke.
  static func inks(_ scheme: ColorScheme, hue: Float = 0.62, red: Float = 0.95) -> [DitherFrame.Ink] {
    scheme == .light
      ? [.init(0x4A5CD4, hue * 0.85), .init(0xD2404F, red * 0.9)]
      : [.init(0x8FA2FF, hue), .init(0xF07D88, red)]
  }
}

/// A dithered scene that changes over time, filling its frame. Holds still with Reduce Motion or
/// when given a `time`.
struct DitherCanvas: View {
  var cell: Double = 3
  var fps: Double = 24
  /// A fixed time, for still renders.
  var time: Double? = nil
  let inks: [DitherFrame.Ink]
  let draw: (inout DitherFrame, Double) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Holds still while the window isn't the active one, so it costs nothing in the background.
  @Environment(\.controlActiveState) private var active

  var body: some View {
    GeometryReader { geo in
      let w = max(1, Int(geo.size.width / cell)), h = max(1, Int(geo.size.height / cell))
      TimelineView(.animation(minimumInterval: 1 / fps, paused: time != nil || reduceMotion || active == .inactive)) { timeline in
        let t = time ?? (reduceMotion ? 20 : Dither.clock(timeline.date))
        if let image = render(w, h, t) {
          Image(decorative: image, scale: 1)
            .resizable()
            .interpolation(.none)
            .frame(width: Double(w) * cell, height: Double(h) * cell)
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  private func render(_ w: Int, _ h: Int, _ t: Double) -> CGImage? {
    var frame = DitherFrame(width: w, height: h, cell: cell, inks: inks)
    draw(&frame, t)
    return frame.image()
  }
}

// MARK: - Small pieces

/// A band of light that sparkles, brightest along its lower edge: what a scan leaves behind it.
struct ScanBand: View {
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    DitherCanvas(cell: 3, fps: 30, inks: Dither.inks(scheme, hue: 0.8)) { f, t in
      let tick = Int(t * 30)
      for y in 0..<f.height {
        let edge = Double(y + 1) / Double(f.height)
        let base = edge * edge * edge
        for x in 0..<f.width {
          f.put(x, y, base * (0.5 + 0.7 * Dither.noise(x, y, tick)))
        }
      }
    }
    .overlay(alignment: .bottom) { Rectangle().fill(Theme.accent.opacity(0.7)).frame(height: 1) }
  }
}

/// A thin strip of cells with light running along it: something is being read, or waited for.
struct DitherBar: View {
  var width: CGFloat = 72
  var height: CGFloat = 6
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    DitherCanvas(cell: 2, fps: 30, inks: Dither.inks(scheme, hue: 0.9)) { f, t in
      let at = (t * 0.6).truncatingRemainder(dividingBy: 1) * 1.6 - 0.3
      for x in 0..<f.width {
        let u = Double(x) / Double(max(1, f.width - 1))
        let v = 0.1 + 0.95 * exp(-pow((u - at) / 0.18, 2))
        for y in 0..<f.height { f.put(x, y, v) }
      }
    }
    .frame(width: width, height: height)
  }
}

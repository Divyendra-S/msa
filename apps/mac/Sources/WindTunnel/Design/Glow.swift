import SwiftUI

/// A soft light in one corner of a view: a mesh gradient in the hue, deep to light, whose points
/// drift very slowly, under a fine film grain so it never bands or looks flat. For behind content,
/// at low strength; it holds still with Reduce Motion.
struct Glow: View {
  enum Corner { case bottomTrailing, topTrailing, bottomLeading, topLeading }

  var corner: Corner = .bottomTrailing
  /// 0…1: how much of the light shows.
  var strength: Double = 1
  /// A fixed time, for still renders.
  var time: Double? = nil
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: time != nil || reduceMotion)) { timeline in
      let t = time ?? (reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 10_000))
      MeshGradient(width: 4, height: 4, points: Self.points(t), colors: scheme == .light ? Self.lightColors : Self.colors, smoothsColors: true, colorSpace: .perceptual)
    }
    .scaleEffect(x: corner == .bottomLeading || corner == .topLeading ? -1 : 1, y: corner == .topTrailing || corner == .topLeading ? -1 : 1)
    .opacity(strength)
    .overlay(Grain())
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// The light sits in the bottom right; everything else is clear.
  private static let colors: [Color] = {
    let c = Color(hex: 0x0B0C10, opacity: 0)
    let deep = Color(hex: 0x1A1F42, opacity: 0.55)
    let deeper = Color(hex: 0x212955, opacity: 0.7)
    let mid = Color(hex: 0x2D3878, opacity: 0.72)
    let blue = Color(hex: 0x384793, opacity: 0.7)
    let bright = Color(hex: 0x4C5DAE, opacity: 0.78)
    let light = Color(hex: 0x8C98D2, opacity: 0.55)
    return [
      c, c, c, c,
      c, c, deep, deeper,
      c, deep, mid, blue,
      deeper, mid, bright, light,
    ]
  }()

  /// On light: a pale wash of the hue instead of a deep one.
  private static let lightColors: [Color] = {
    let c = Color(hex: 0xF6F6F8, opacity: 0)
    let deep = Color(hex: 0xE2E7FF, opacity: 0.6)
    let deeper = Color(hex: 0xD2DAFF, opacity: 0.7)
    let mid = Color(hex: 0xBCC8FF, opacity: 0.7)
    let blue = Color(hex: 0xA9B8FF, opacity: 0.7)
    let bright = Color(hex: 0x95A7FA, opacity: 0.7)
    let light = Color(hex: 0xC4CFFF, opacity: 0.8)
    return [
      c, c, c, c,
      c, c, deep, deeper,
      c, deep, mid, blue,
      deeper, mid, bright, light,
    ]
  }()

  /// A 4×4 grid whose inner points wander a few percent, each on its own slow cycle; points on the
  /// edges only slide along them.
  private static func points(_ t: Double) -> [SIMD2<Float>] {
    var out: [SIMD2<Float>] = []
    for row in 0..<4 {
      for col in 0..<4 {
        var x = Double(col) / 3, y = Double(row) / 3
        let seed = Double(row * 4 + col)
        let dx = 0.07 * sin(t * (0.09 + 0.013 * seed) + seed * 1.7)
        let dy = 0.07 * cos(t * (0.075 + 0.011 * seed) + seed * 2.3)
        if col > 0 && col < 3 { x += dx }
        if row > 0 && row < 3 { y += dy }
        out.append(SIMD2(Float(x), Float(y)))
      }
    }
    return out
  }
}

/// Film grain: fixed noise, tiled, laid over whatever is under it.
struct Grain: View {
  var amount: Double = 1

  var body: some View {
    if let tile = Self.tile {
      Image(decorative: tile, scale: 2)
        .resizable(resizingMode: .tile)
        .blendMode(.overlay)
        .opacity(0.55 * amount)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
  }

  /// 256 pixels of grey noise, made once.
  private static let tile: CGImage? = {
    let size = 256
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    var pixels = [UInt8](repeating: 0, count: size * size)
    for i in pixels.indices {
      // xorshift: cheap, and the same every launch.
      state ^= state << 13
      state ^= state >> 7
      state ^= state << 17
      pixels[i] = UInt8(truncatingIfNeeded: 96 + Int(state % 64))
    }
    guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
    return CGImage(
      width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size, space: CGColorSpaceCreateDeviceGray(),
      bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }()
}

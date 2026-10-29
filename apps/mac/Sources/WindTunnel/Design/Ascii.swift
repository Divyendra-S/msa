import SwiftUI

/// ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
struct BrailleSpinner: View {
  var color: Color = Theme.accent
  var size: CGFloat = 11
  private static let frames = Array("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏").map(String.init)

  var body: some View {
    TimelineView(.periodic(from: .now, by: 0.08)) { context in
      let i = Int(context.date.timeIntervalSinceReferenceDate / 0.08) % Self.frames.count
      Text(Self.frames[i]).font(Theme.mono(size, .bold)).foregroundStyle(color)
    }
  }
}

/// Monospaced text that decodes itself: random glyphs settle into it, left to right.
struct ScrambleText: View {
  let text: String
  var font: Font = Theme.mono(13)
  var color: Color = Theme.text
  var duration: Double = 0.55
  @State private var start = Date.distantPast
  private static let noise = Array("░▒<>/\\|=+*#%_:·")

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 40, paused: Date().timeIntervalSince(start) > duration + 0.1)) { context in
      let progress = min(1, context.date.timeIntervalSince(start) / duration)
      Text(scrambled(progress, seed: Int(context.date.timeIntervalSinceReferenceDate * 30)))
        .font(font)
        .foregroundStyle(color)
    }
    .onAppear { start = .now }
    .onChange(of: text) { start = .now }
  }

  private func scrambled(_ p: Double, seed: Int) -> String {
    if p >= 1 { return text }
    let chars = Array(text)
    let settled = Int(Double(chars.count) * p)
    var out = ""
    for (i, c) in chars.enumerated() {
      if i < settled || c == " " { out.append(c) } else {
        out.append(Self.noise[abs(seed &+ i &* 7) % Self.noise.count])
      }
    }
    return out
  }
}

/// A dot that breathes while something is live.
struct LiveDot: View {
  var on: Bool
  var color: Color = Theme.accent

  var body: some View {
    ZStack {
      if on {
        Circle()
          .fill(color.opacity(0.35))
          .frame(width: 7, height: 7)
          .phaseAnimator([1.0, 2.6]) { view, scale in
            view.scaleEffect(scale).opacity(2.8 - scale)
          } animation: { _ in .easeOut(duration: 1.4) }
      }
      Circle().fill(on ? color : Theme.ghost).frame(width: 6, height: 6)
    }
    .frame(width: 14, height: 14)
  }
}

/// The mark: three lines of air through a wind tunnel's narrow throat, deep to light.
struct LogoMark: View {
  var size: CGFloat = 18

  var body: some View {
    Canvas { context, s in
      let w = s.width, h = s.height
      let line = max(1.2, w * 0.085)
      var p = Path()
      for (y0, pinch) in [(0.2, 0.17), (0.5, 0.0), (0.8, -0.17)] {
        p.move(to: CGPoint(x: 0.04 * w, y: y0 * h))
        p.addCurve(to: CGPoint(x: 0.5 * w, y: (y0 + pinch) * h), control1: CGPoint(x: 0.26 * w, y: y0 * h), control2: CGPoint(x: 0.32 * w, y: (y0 + pinch) * h))
        p.addCurve(to: CGPoint(x: 0.96 * w, y: y0 * h), control1: CGPoint(x: 0.68 * w, y: (y0 + pinch) * h), control2: CGPoint(x: 0.74 * w, y: y0 * h))
      }
      context.stroke(
        p, with: .linearGradient(Gradient(colors: [Theme.accentDeep, Theme.accent, Theme.accentLight]), startPoint: .zero, endPoint: CGPoint(x: w, y: 0)),
        style: StrokeStyle(lineWidth: line, lineCap: .round))
    }
    .frame(width: size, height: size)
  }
}

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

/// A word that decodes itself: random glyphs settle into the text, left to right.
struct ScrambleText: View {
  let text: String
  var font: Font = Theme.mono(13)
  var color: Color = Theme.text
  var duration: Double = 0.55
  @State private var start = Date.distantPast
  private static let noise = Array("▓▒░█<>/\\|=+*#%_—:·")

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

/// ▕██████▍░░░░░▏ with eighths for the partial cell.
struct AsciiBar: View {
  let value: Double
  var width = 18
  var color: Color = Theme.accent
  var track: Color = Theme.ghost
  var font: Font = Theme.mono(11)

  var body: some View {
    let v = min(1, max(0, value.isFinite ? value : 0))
    let eighths = Int((v * Double(width * 8)).rounded())
    let full = eighths / 8
    let part = eighths % 8
    let partials = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"]
    let filled = String(repeating: "█", count: full) + partials[part]
    let rest = String(repeating: "░", count: max(0, width - full - (part > 0 ? 1 : 0)))
    (Text(filled).foregroundStyle(color) + Text(rest).foregroundStyle(track))
      .font(font)
      .contentTransition(.interpolate)
      .animation(Theme.spring, value: eighths)
  }
}

/// One glyph per repetition, coloured by outcome: ● pass ✗ broke a rule ■ error ○ running.
struct RepStrip: View {
  let outcomes: [String]
  var pending = 0
  var selected: Int? = nil
  var onSelect: ((Int) -> Void)? = nil

  var body: some View {
    HStack(spacing: 3) {
      ForEach(Array(outcomes.enumerated()), id: \.offset) { i, outcome in
        let tone = Tone(outcome)
        Text(tone.glyph)
          .font(Theme.mono(12, .bold))
          .foregroundStyle(tone.color)
          .frame(width: 18, height: 20)
          .background(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
              .fill(selected == i + 1 ? tone.color.opacity(0.16) : Color.clear)
          )
          .overlay(
            RoundedRectangle(cornerRadius: 4, style: .continuous)
              .strokeBorder(selected == i + 1 ? tone.color.opacity(0.6) : Color.clear, lineWidth: 1)
          )
          .contentShape(Rectangle())
          .onTapGesture { onSelect?(i + 1) }
          .help("repetition \(i + 1): \(outcome)")
      }
      ForEach(0..<max(0, pending), id: \.self) { _ in
        PulsingGlyph()
      }
    }
  }
}

private struct PulsingGlyph: View {
  var body: some View {
    Text("○")
      .font(Theme.mono(12, .bold))
      .foregroundStyle(Theme.accent)
      .frame(width: 18, height: 20)
      .phaseAnimator([0.3, 1]) { view, phase in view.opacity(phase) } animation: { _ in .easeInOut(duration: 0.7) }
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
      Circle().fill(on ? color : Theme.faint).frame(width: 6, height: 6)
    }
    .frame(width: 14, height: 14)
  }
}

/// A block cursor that blinks.
struct BlinkCursor: View {
  var color: Color = Theme.accent

  var body: some View {
    Rectangle()
      .fill(color)
      .frame(width: 7, height: 14)
      .phaseAnimator([1.0, 0.0]) { view, o in view.opacity(o) } animation: { _ in .easeInOut(duration: 0.5).delay(0.25) }
  }
}

/// WIND TUNNEL in a block letter face, revealed by a sweep from the left.
struct AsciiLogo: View {
  var fontSize: CGFloat = 9
  var color: Color = Theme.text
  var animated = true
  @State private var revealed: CGFloat = 0

  static let art = [
    "██╗    ██╗██╗███╗   ██╗██████╗     ████████╗██╗   ██╗███╗   ██╗███╗   ██╗███████╗██╗     ",
    "██║    ██║██║████╗  ██║██╔══██╗    ╚══██╔══╝██║   ██║████╗  ██║████╗  ██║██╔════╝██║     ",
    "██║ █╗ ██║██║██╔██╗ ██║██║  ██║       ██║   ██║   ██║██╔██╗ ██║██╔██╗ ██║█████╗  ██║     ",
    "██║███╗██║██║██║╚██╗██║██║  ██║       ██║   ██║   ██║██║╚██╗██║██║╚██╗██║██╔══╝  ██║     ",
    "╚███╔███╔╝██║██║ ╚████║██████╔╝       ██║   ╚██████╔╝██║ ╚████║██║ ╚████║███████╗███████╗",
    " ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═════╝        ╚═╝    ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚══════╝",
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(Self.art.enumerated()), id: \.offset) { _, line in
        // The faces (█) bright, the shadows (╗║═) dim; rows close up so the blocks join.
        Text(styled(line)).fixedSize().frame(height: fontSize * 1.06, alignment: .center)
      }
    }
    .font(Theme.mono(fontSize, .regular))
    .fixedSize()
    .mask(alignment: .leading) {
      GeometryReader { geo in
        LinearGradient(
          stops: [.init(color: .black, location: 0), .init(color: .black, location: max(0, revealed - 0.06)), .init(color: .clear, location: revealed)],
          startPoint: .leading, endPoint: .trailing
        )
        .frame(width: geo.size.width)
      }
    }
    .overlay {
      // A glint that sweeps across now and then.
      if animated {
        TimelineView(.animation(minimumInterval: 1 / 30)) { context in
          let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 6) / 6
          GeometryReader { geo in
            LinearGradient(colors: [.clear, Theme.accent.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
              .frame(width: 90)
              .offset(x: CGFloat(t) * (geo.size.width + 300) - 150)
              .blendMode(.plusLighter)
          }
          .mask {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(Self.art.enumerated()), id: \.offset) { _, line in
                Text(line).fixedSize().frame(height: fontSize * 1.06, alignment: .center)
              }
            }
            .font(Theme.mono(fontSize))
            .fixedSize()
          }
        }
      }
    }
    .onAppear {
      if animated {
        withAnimation(.easeOut(duration: 1.1)) { revealed = 1.08 }
      } else {
        revealed = 1.08
      }
    }
  }

  private func styled(_ line: String) -> AttributedString {
    var out = AttributedString()
    var run = ""
    var face: Bool? = nil
    func flush() {
      guard !run.isEmpty, let f = face else { return }
      var piece = AttributedString(run)
      piece.foregroundColor = f ? color : color.opacity(0.32)
      out += piece
      run = ""
    }
    for c in line {
      let isFace = c == "█"
      if face != isFace { flush(); face = isFace }
      run.append(c)
    }
    flush()
    return out
  }
}

/// A rule of box-drawing characters that fills its width: ────────
struct HairlineText: View {
  var char = "─"
  var color: Color = Theme.ghost

  var body: some View {
    GeometryReader { geo in
      Text(String(repeating: char, count: max(0, Int(geo.size.width / 6.6))))
        .font(Theme.mono(11))
        .foregroundStyle(color)
        .lineLimit(1)
        .fixedSize()
    }
    .frame(height: 13)
    .clipped()
  }
}

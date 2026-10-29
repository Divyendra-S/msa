import AppKit
import SwiftUI

/// The look: dark glass. The window lets the desktop through, blurred and tinted ink, with a faint
/// wash of colour; content sits on it in translucent cards with lit hairline edges. SF Pro for the
/// interface, SF Mono only for data (ids, rules, SQL, logs). One cool gradient, lavender to
/// periwinkle to aqua, stands for air and for what's live.
enum Theme {
  // Surfaces, over the glass.
  static let ink = Color(hex: 0x090A10)
  static let card = Color.white.opacity(0.035)
  static let cardHover = Color.white.opacity(0.055)
  static let selection = Color.white.opacity(0.085)
  static let well = Color.black.opacity(0.22)
  static let line = Color.white.opacity(0.07)
  static let lineStrong = Color.white.opacity(0.12)

  // Text.
  static let text = Color(hex: 0xF3F4F8)
  static let dim = Color.white.opacity(0.64)
  static let faint = Color.white.opacity(0.42)
  static let ghost = Color.white.opacity(0.24)

  // Colour.
  static let accent = Color(hex: 0xA3B5FF)
  static let lavender = Color(hex: 0xCDB8FF)
  static let aqua = Color(hex: 0x8BE3DA)
  static let pass = Color(hex: 0x7ADFA6)
  static let fail = Color(hex: 0xFF7F8C)
  static let flaky = Color(hex: 0xF4C978)
  static let error = Color(hex: 0xC9A8FF)

  static let airGradient: [Color] = [lavender, accent, aqua]
  /// The same air, a little deeper, for characters drawn thin on dark glass.
  static let asciiGradient: [Color] = [Color(hex: 0xBBA1FF), Color(hex: 0x91A6FF), Color(hex: 0x72DCD2)]
  static var air: LinearGradient { LinearGradient(colors: airGradient, startPoint: .topLeading, endPoint: .bottomTrailing) }

  /// Actors in a run (browser tabs, webhooks), in the order they appear.
  static let actors: [Color] = [Color(hex: 0x9FC2FF), Color(hex: 0xF4A9D6), Color(hex: 0xB7EB8F), Color(hex: 0xFFC28A), Color(hex: 0xC4B5FF)]

  static func actor(_ i: Int) -> Color { actors[((i % actors.count) + actors.count) % actors.count] }

  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }

  static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .default)
  }

  /// Big figures: light and tabular.
  static func figure(_ size: CGFloat, _ weight: Font.Weight = .light) -> Font {
    .system(size: size, weight: weight, design: .default).monospacedDigit()
  }

  static let radius: CGFloat = 16
  static let spring = Animation.spring(response: 0.38, dampingFraction: 0.86)
  static let snappy = Animation.spring(response: 0.24, dampingFraction: 0.9)
}

extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity
    )
  }
}

/// pass/ok → pass, fail/broken → fail, flaky → flaky, error → error, running → live, others muted.
enum Tone {
  case pass, fail, flaky, error, live, muted

  init(_ outcome: String?) {
    switch outcome {
    case "pass", "ok", "done": self = .pass
    case "fail", "broken", "failed": self = .fail
    case "flaky": self = .flaky
    case "running": self = .live
    case "error": self = .error
    default: self = .muted
    }
  }

  var color: Color {
    switch self {
    case .pass: Theme.pass
    case .fail: Theme.fail
    case .flaky: Theme.flaky
    case .error: Theme.error
    case .live: Theme.aqua
    case .muted: Theme.faint
    }
  }

  /// One character for an outcome, for text.
  var glyph: String {
    switch self {
    case .pass: "●"
    case .fail: "✕"
    case .flaky: "▲"
    case .error: "■"
    case .live, .muted: "○"
    }
  }

  /// An outcome as a word: `Held`, `Broke`, `Flaky`.
  static func word(_ outcome: String) -> String {
    switch outcome {
    case "ok": "Held"
    case "broken": "Broke"
    default: outcome.prefix(1).uppercased() + outcome.dropFirst()
    }
  }
}

// MARK: - Surfaces

/// The window's backdrop: the desktop blurred behind it, tinted ink, with a faint wash of the air
/// colours in two corners.
struct Backdrop: View {
  var body: some View {
    ZStack {
      BehindWindowBlur()
      Theme.ink.opacity(0.82)
      RadialGradient(colors: [Theme.lavender.opacity(0.13), .clear], center: UnitPoint(x: 0.02, y: -0.05), startRadius: 0, endRadius: 780)
      RadialGradient(colors: [Theme.aqua.opacity(0.08), .clear], center: UnitPoint(x: 1.02, y: 1.05), startRadius: 0, endRadius: 880)
      RadialGradient(colors: [Theme.accent.opacity(0.05), .clear], center: UnitPoint(x: 0.72, y: 0.12), startRadius: 0, endRadius: 620)
    }
    .ignoresSafeArea()
    .allowsHitTesting(false)
  }
}

/// What's behind the window, blurred.
struct BehindWindowBlur: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .underWindowBackground
    view.blendingMode = .behindWindow
    view.state = .active
    view.appearance = NSAppearance(named: .darkAqua)
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

/// A translucent card with a lit hairline edge; tinted for a card that carries an outcome.
struct CardBackground: ViewModifier {
  var radius: CGFloat = Theme.radius
  var tint: Color? = nil
  var hover = false

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
    content.background {
      shape
        .fill(tint.map { $0.opacity(hover ? 0.08 : 0.055) } ?? (hover ? Theme.cardHover : Theme.card))
        .overlay(
          shape.strokeBorder(
            LinearGradient(
              colors: [(tint ?? .white).opacity(tint == nil ? 0.11 : 0.34), (tint ?? .white).opacity(tint == nil ? 0.035 : 0.1)],
              startPoint: .top, endPoint: .bottom),
            lineWidth: 1)
        )
    }
  }
}

extension View {
  func card(radius: CGFloat = Theme.radius, tint: Color? = nil, hover: Bool = false) -> some View {
    modifier(CardBackground(radius: radius, tint: tint, hover: hover))
  }

  /// Liquid Glass where there is some (macOS 26), a thin material before it.
  @ViewBuilder
  func glass(_ shape: some Shape, interactive: Bool = false) -> some View {
    if #available(macOS 26.0, *) {
      glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    } else {
      background(.ultraThinMaterial, in: shape).overlay(shape.stroke(Theme.line, lineWidth: 1))
    }
  }
}

// MARK: - Text styles

extension View {
  /// A small heading over a column or a group: `REPETITIONS`.
  func label(_ color: Color = Theme.faint) -> some View {
    font(Theme.sans(10.5, .semibold)).tracking(0.7).foregroundStyle(color).textCase(.uppercase)
  }
}

/// A card with a title row: the title on the left, an accessory on the right.
struct Panel<Content: View, Accessory: View>: View {
  let title: String
  var tint: Color? = nil
  var mono = false
  var padding: CGFloat = 18
  @ViewBuilder var accessory: () -> Accessory
  @ViewBuilder var content: () -> Content

  init(
    _ title: String, tint: Color? = nil, mono: Bool = false, padding: CGFloat = 18,
    @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() },
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.title = title
    self.tint = tint
    self.mono = mono
    self.padding = padding
    self.accessory = accessory
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(mono ? Theme.mono(12.5, .medium) : Theme.sans(13, .semibold))
          .foregroundStyle(tint ?? Theme.text.opacity(0.92))
        Spacer(minLength: 8)
        accessory().font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(padding)
    .card(tint: tint)
  }
}

/// `● Fail`: an outcome in a soft capsule.
struct OutcomeBadge: View {
  let outcome: String
  var large = false

  var body: some View {
    let tone = Tone(outcome)
    HStack(spacing: large ? 6 : 5) {
      if tone == .live {
        BrailleSpinner(color: tone.color, size: large ? 11 : 9)
      } else {
        Circle().fill(tone.color).frame(width: large ? 6 : 5, height: large ? 6 : 5)
      }
      Text(Tone.word(outcome))
    }
    .font(Theme.sans(large ? 12 : 10.5, .semibold))
    .foregroundStyle(tone.color)
    .padding(.horizontal, large ? 10 : 7)
    .padding(.vertical, large ? 4.5 : 2.5)
    .background(Capsule().fill(tone.color.opacity(0.13)))
    .fixedSize()
  }
}

/// A quiet capsule of text.
struct Chip: View {
  let text: String
  var color: Color = Theme.dim

  var body: some View {
    Text(text)
      .font(Theme.sans(11.5))
      .foregroundStyle(color)
      .padding(.horizontal, 9)
      .padding(.vertical, 3.5)
      .background(Capsule().fill(Color.white.opacity(0.06)))
  }
}

/// Capsule buttons. Prominent: a light pill (or a coloured one); otherwise a quiet glass pill.
struct GlassButtonStyle: ButtonStyle {
  var prominent = false
  var color: Color? = nil

  func makeBody(configuration: Configuration) -> some View {
    GlassButtonBody(configuration: configuration, prominent: prominent, color: color)
  }
}

private struct GlassButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  let color: Color?
  @State private var hovering = false
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    configuration.label
      .font(Theme.sans(12.5, .medium))
      .labelStyle(PillLabelStyle())
      .foregroundStyle(foreground)
      .padding(.horizontal, 14)
      .frame(height: 30)
      .background {
        if prominent {
          Capsule().fill(enabled ? (color ?? Theme.text).opacity(hovering ? 1 : 0.92) : Color.white.opacity(0.08))
            .shadow(color: enabled ? (color ?? Theme.accent).opacity(hovering ? 0.35 : 0.16) : .clear, radius: hovering ? 14 : 8, y: 2)
        } else {
          Capsule().fill(Color.white.opacity(hovering && enabled ? 0.11 : 0.065))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
        }
      }
      .contentShape(Capsule())
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(Theme.snappy, value: hovering)
      .animation(Theme.snappy, value: configuration.isPressed)
      .onHover { hovering = $0 }
  }

  private var foreground: Color {
    if !enabled { return Theme.ghost }
    if prominent { return Theme.ink }
    return color ?? (hovering ? Theme.text : Theme.text.opacity(0.86))
  }
}

private struct PillLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) {
      configuration.icon.font(.system(size: 11, weight: .semibold))
      configuration.title
    }
  }
}

/// A row of options in a capsule track, the chosen one on a lit thumb that slides between them.
struct Segmented<Item: Hashable, ItemLabel: View>: View {
  let items: [Item]
  @Binding var selection: Item
  @ViewBuilder var label: (Item, Bool) -> ItemLabel
  @Namespace private var thumb

  var body: some View {
    HStack(spacing: 2) {
      ForEach(items, id: \.self) { item in
        let on = item == selection
        Button {
          withAnimation(Theme.spring) { selection = item }
        } label: {
          label(item, on)
            .font(Theme.sans(12, on ? .semibold : .medium))
            .foregroundStyle(on ? Theme.text : Theme.dim)
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background {
              if on {
                Capsule().fill(Color.white.opacity(0.12))
                  .overlay(Capsule().strokeBorder(Color.white.opacity(0.1), lineWidth: 1))
                  .shadow(color: .black.opacity(0.25), radius: 4, y: 1)
                  .matchedGeometryEffect(id: "thumb", in: thumb)
              }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(2)
    .background(Capsule().fill(Color.black.opacity(0.18)))
    .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1))
    .fixedSize()
  }
}

/// A thin capsule filled to a value.
struct Meter: View {
  let value: Double
  var color: Color = Theme.accent
  var height: CGFloat = 4

  var body: some View {
    let v = min(1, max(0, value.isFinite ? value : 0))
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.white.opacity(0.07))
        if v > 0 {
          Capsule().fill(color.gradient).frame(width: max(height, geo.size.width * v))
        }
      }
    }
    .frame(height: height)
    .animation(Theme.spring, value: v)
  }
}

/// One bar split by outcome: pass, fail, flaky, never run.
struct SplitBar: View {
  let parts: [(Int, Color)]
  var height: CGFloat = 6

  var body: some View {
    let total = max(1, parts.reduce(0) { $0 + $1.0 })
    GeometryReader { geo in
      let shown = parts.filter { $0.0 > 0 }
      let gaps = CGFloat(max(0, shown.count - 1)) * 3
      HStack(spacing: 3) {
        ForEach(Array(shown.enumerated()), id: \.offset) { _, p in
          Capsule().fill(p.1.gradient).frame(width: max(height, (geo.size.width - gaps) * CGFloat(p.0) / CGFloat(total)))
        }
      }
    }
    .frame(height: height)
  }
}

/// A dot per repetition, coloured by outcome, the chosen one ringed; pending ones breathe.
struct RepDots: View {
  let outcomes: [String]
  var pending = 0
  var selected: Int? = nil
  var onSelect: ((Int) -> Void)? = nil

  var body: some View {
    HStack(spacing: 4) {
      ForEach(Array(outcomes.enumerated()), id: \.offset) { i, outcome in
        let tone = Tone(outcome)
        Circle()
          .fill(tone.color.gradient)
          .frame(width: 10, height: 10)
          .padding(4)
          .overlay(Circle().strokeBorder(selected == i + 1 ? tone.color.opacity(0.85) : .clear, lineWidth: 1.5))
          .contentShape(Circle())
          .onTapGesture { onSelect?(i + 1) }
          .help("Repetition \(i + 1): \(Tone.word(outcome).lowercased())")
      }
      ForEach(0..<max(0, pending), id: \.self) { _ in
        Circle()
          .strokeBorder(Theme.aqua, lineWidth: 1.5)
          .frame(width: 10, height: 10)
          .padding(4)
          .phaseAnimator([0.3, 1]) { view, phase in view.opacity(phase) } animation: { _ in .easeInOut(duration: 0.7) }
      }
    }
  }
}

/// Fades a view in and up when it first appears, after `delay`.
struct Rise: ViewModifier {
  var delay: Double = 0
  @State private var shown = false

  func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown ? 0 : 8)
      .onAppear {
        withAnimation(Theme.spring.delay(delay)) { shown = true }
      }
  }
}

extension View {
  func rise(_ delay: Double = 0) -> some View { modifier(Rise(delay: delay)) }
}

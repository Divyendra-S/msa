import AppKit
import SwiftUI

/// The look: quiet glass, dark or light. The window lets the desktop through, blurred and tinted. Content sits
/// straight on it, in sections split by hairlines rather than boxed in cards. One hue, a cool blue,
/// for the brand, for what's live and for what holds; red and amber only where something needs a
/// look. SF Pro for the interface, SF Mono only for data (ids, rules, SQL, logs). Small radii.
enum Theme {
  // Surfaces, over the glass.
  static let ink = Color.adaptive(dark: Color(hex: 0x0B0C10), light: Color(hex: 0xF6F6F8))
  static let well = Color.adaptive(dark: .black.opacity(0.22), light: .black.opacity(0.04))
  static let fill = overlay(0.055)
  static let hover = overlay(0.04)
  static let selection = overlay(0.075)
  static let line = Color.adaptive(dark: .white.opacity(0.075), light: .black.opacity(0.085))
  static let lineStrong = Color.adaptive(dark: .white.opacity(0.13), light: .black.opacity(0.15))

  /// The content colour at `amount`: white on dark, black on light. For fills and tracks.
  static func overlay(_ amount: Double) -> Color {
    .adaptive(dark: .white.opacity(amount), light: .black.opacity(amount * 0.85))
  }

  // Text.
  static let text = Color.adaptive(dark: Color(hex: 0xEDEEF2), light: Color(hex: 0x16171B))
  static let dim = Color.adaptive(dark: .white.opacity(0.6), light: .black.opacity(0.62))
  static let faint = Color.adaptive(dark: .white.opacity(0.4), light: .black.opacity(0.46))
  static let ghost = Color.adaptive(dark: .white.opacity(0.22), light: .black.opacity(0.26))

  // The one hue, light to deep; deeper on light backgrounds so it reads.
  static let accent = Color.adaptive(dark: 0x8FA2FF, light: 0x4A5CD4)
  static let accentLight = Color.adaptive(dark: 0xCCD4FF, light: 0x7E90EC)
  static let accentDeep = Color.adaptive(dark: 0x4D5FBF, light: 0x33429F)
  /// The hue as a gradient, deep to light: for the mark.
  static let hue: [Color] = [accentDeep, accent, accentLight]

  // Outcomes. Passing stays neutral so failures are what you see.
  static let pass = Color.adaptive(dark: .white.opacity(0.36), light: .black.opacity(0.3))
  static let fail = Color.adaptive(dark: 0xF07D88, light: 0xD2404F)
  static let flaky = Color.adaptive(dark: 0xE6C17C, light: 0xB07818)
  static let error = flaky

  /// Actors in a run (browser tabs, webhooks), in the order they appear: shades of the hue.
  static let actors: [Color] = [
    .adaptive(dark: 0xB9C5FF, light: 0x4F63D8), .adaptive(dark: 0xE4E6EC, light: 0x3B3E48), .adaptive(dark: 0x7E92F2, light: 0x7486E6),
    .adaptive(dark: 0x9DA5BE, light: 0x7A8296), .adaptive(dark: 0x6274D6, light: 0x2D3C99),
  ]

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

  // The type scale. Interface text is 11, 12, 13, 15 or 17; titles 22; the start screens' headlines
  // 30 and 44. Mono is 10 to 13. Nothing in between, so sizes alone show what matters.

  /// A start screen's headline: `Which app should we try to break?`
  static let display = Font.system(size: 44, weight: .semibold)
  static let displayTracking: CGFloat = -1.4
  /// A screen's own name: the app on the second start screen, an empty pane's next step.
  static let title = Font.system(size: 30, weight: .semibold)
  static let titleTracking: CGFloat = -0.8

  /// Space either side of a pane, shared by the top bar so titles and content line up.
  static let gutter: CGFloat = 28
  /// The widest a pane's content gets. Wider windows leave the room on the right.
  static let measure: CGFloat = 1100
  /// The start screens' left margin.
  static let startMargin: CGFloat = 72

  /// Corners: wells and fields; controls are a little tighter.
  static let radius: CGFloat = 8
  static let controlRadius: CGFloat = 6
  static let spring = Animation.spring(response: 0.38, dampingFraction: 0.86)
  static let snappy = Animation.spring(response: 0.24, dampingFraction: 0.9)
}

extension Color {
  /// One colour on dark, another on light, chosen by the appearance it's drawn in.
  static func adaptive(dark: Color, light: Color) -> Color {
    Color(nsColor: NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .aqua ? NSColor(light) : NSColor(dark)
    })
  }

  static func adaptive(dark: UInt32, light: UInt32) -> Color {
    adaptive(dark: Color(hex: dark), light: Color(hex: light))
  }

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
    case .live: Theme.accent
    case .muted: Theme.ghost
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

  /// An outcome as a word: `Passed`, `Failed`, `Held`, `Broke`.
  static func word(_ outcome: String) -> String {
    switch outcome {
    case "ok": "Held"
    case "broken": "Broke"
    case "pass": "Passed"
    case "fail": "Failed"
    default: outcome.prefix(1).uppercased() + outcome.dropFirst()
    }
  }
}

// MARK: - Surfaces

/// The window's backdrop: the desktop blurred behind it, tinted ink, with one faint wash of the hue.
struct Backdrop: View {
  var body: some View {
    ZStack {
      BehindWindowBlur()
      Theme.ink.opacity(0.84)
      RadialGradient(colors: [Theme.accent.opacity(0.07), .clear], center: UnitPoint(x: 0.85, y: -0.1), startRadius: 0, endRadius: 900)
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
    return view
  }

  func updateNSView(_ view: NSVisualEffectView, context: Context) {}
}

extension View {
  /// Liquid Glass where there is some (macOS 26), a thin material before it. For things that float.
  @ViewBuilder
  func glass(_ shape: some Shape, interactive: Bool = false) -> some View {
    if #available(macOS 26.0, *) {
      glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    } else {
      background(.ultraThinMaterial, in: shape).overlay(shape.stroke(Theme.line, lineWidth: 1))
    }
  }

  /// A recessed block for code, tables and logs: a darker fill, no edge.
  func well(padding: CGFloat = 12) -> some View {
    self.padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
  }
}

/// A one-point rule across or down.
struct Hairline: View {
  var vertical = false

  var body: some View {
    Rectangle().fill(Theme.line).frame(width: vertical ? 1 : nil, height: vertical ? nil : 1)
  }
}

// MARK: - Text styles

extension View {
  /// A small heading over a column: `Repetitions`.
  func label(_ color: Color = Theme.faint) -> some View {
    font(Theme.sans(11, .medium)).foregroundStyle(color)
  }
}

/// A section: a hairline, a title with an accessory on the right, then the content. No box.
struct Panel<Content: View, Accessory: View>: View {
  let title: String
  var tint: Color? = nil
  var mono = false
  var rule = true
  @ViewBuilder var accessory: () -> Accessory
  @ViewBuilder var content: () -> Content

  init(
    _ title: String, tint: Color? = nil, mono: Bool = false, rule: Bool = true,
    @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() },
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.title = title
    self.tint = tint
    self.mono = mono
    self.rule = rule
    self.accessory = accessory
    self.content = content
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if rule { Hairline() }
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(mono ? Theme.mono(12, .medium) : Theme.sans(13, .semibold))
          .foregroundStyle(tint ?? Theme.text)
        Spacer(minLength: 8)
        accessory().font(Theme.sans(12)).foregroundStyle(Theme.faint)
      }
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// `● Failed`: an outcome as a word in its colour, with a dot. Passing reads quietly.
struct OutcomeBadge: View {
  let outcome: String
  var large = false

  var body: some View {
    let tone = Tone(outcome)
    HStack(spacing: 6) {
      if tone == .live {
        BrailleSpinner(color: tone.color, size: large ? 11 : 10)
      } else {
        Circle().fill(tone.color).frame(width: 6, height: 6)
      }
      Text(Tone.word(outcome))
    }
    .font(Theme.sans(large ? 12.5 : 11.5, .medium))
    .foregroundStyle(tone == .pass ? Theme.dim : tone.color)
    .fixedSize()
  }
}

/// Buttons: small rounded rectangles. Prominent is light on dark; the rest a quiet fill. Large is
/// for the one thing a start screen asks for.
struct ActionButtonStyle: ButtonStyle {
  var prominent = false
  var color: Color? = nil
  var large = false
  /// Fills the width it's given, label centred: the main action at the foot of a column.
  var wide = false

  func makeBody(configuration: Configuration) -> some View {
    ActionButtonBody(configuration: configuration, prominent: prominent, color: color, large: large, wide: wide)
  }
}

private struct ActionButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  let color: Color?
  let large: Bool
  let wide: Bool
  @State private var hovering = false
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: large ? Theme.radius : Theme.controlRadius, style: .continuous)
    configuration.label
      .font(Theme.sans(large ? 13 : 12, .medium))
      .labelStyle(ActionLabelStyle())
      .foregroundStyle(foreground)
      .padding(.horizontal, large ? 16 : 11)
      .frame(maxWidth: wide ? .infinity : nil)
      .frame(height: large ? 36 : 28)
      .background {
        if prominent {
          shape.fill(enabled ? Theme.text.opacity(hovering ? 1 : 0.92) : Theme.overlay(0.08))
        } else {
          shape.fill(Theme.overlay(hovering && enabled ? 0.1 : 0.06))
        }
      }
      .contentShape(shape)
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
      .opacity(configuration.isPressed ? 0.85 : 1)
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

private struct ActionLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) {
      configuration.icon.font(.system(size: 11, weight: .semibold))
      configuration.title
    }
  }
}

/// A button that reads as words: quiet until the pointer is on it.
struct LinkButtonStyle: ButtonStyle {
  var color: Color = Theme.faint
  var size: CGFloat = 12

  func makeBody(configuration: Configuration) -> some View {
    LinkButtonBody(configuration: configuration, color: color, size: size)
  }
}

private struct LinkButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let color: Color
  let size: CGFloat
  @State private var hovering = false
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    configuration.label
      .font(Theme.sans(size, .medium))
      .labelStyle(ActionLabelStyle())
      .foregroundStyle(!enabled ? Theme.ghost : hovering ? Theme.text : color)
      .opacity(configuration.isPressed ? 0.7 : 1)
      .contentShape(Rectangle())
      .animation(Theme.snappy, value: hovering)
      .onHover { hovering = $0 }
  }
}

/// A keyboard shortcut inside a button's label, `⌘O` or `↩`, a step quieter than the words.
struct KeyHint: View {
  let keys: String

  init(_ keys: String) { self.keys = keys }

  var body: some View {
    Text(keys).font(Theme.sans(11, .medium)).opacity(0.45).padding(.leading, 2)
  }
}

/// Options as a row of words, the chosen one bright and underlined; the line slides between them.
struct TabStrip<Item: Hashable, ItemLabel: View>: View {
  let items: [Item]
  @Binding var selection: Item
  var size: CGFloat = 13
  @ViewBuilder var label: (Item, Bool) -> ItemLabel
  @Namespace private var underline

  init(items: [Item], selection: Binding<Item>, size: CGFloat = 13, @ViewBuilder label: @escaping (Item, Bool) -> ItemLabel) {
    self.items = items
    self._selection = selection
    self.size = size
    self.label = label
  }

  var body: some View {
    HStack(spacing: size > 12 ? 22 : 16) {
      ForEach(items, id: \.self) { item in
        let on = item == selection
        Button {
          withAnimation(Theme.spring) { selection = item }
        } label: {
          label(item, on)
            .font(Theme.sans(size, on ? .medium : .regular))
            .foregroundStyle(on ? Theme.text : Theme.faint)
            .padding(.vertical, 7)
            .overlay(alignment: .bottom) {
              if on {
                Rectangle().fill(Theme.accent).frame(height: 1.5)
                  .matchedGeometryEffect(id: "line", in: underline)
                  .offset(y: 0.5)
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    .fixedSize()
  }
}

/// A thin bar filled to a value.
struct Meter: View {
  let value: Double
  var color: Color = Theme.accent
  var height: CGFloat = 3

  var body: some View {
    let v = min(1, max(0, value.isFinite ? value : 0))
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Rectangle().fill(Theme.overlay(0.08))
        if v > 0 {
          Rectangle().fill(color).frame(width: max(2, geo.size.width * v))
        }
      }
    }
    .frame(height: height)
    .clipShape(RoundedRectangle(cornerRadius: 1))
    .animation(Theme.spring, value: v)
  }
}

/// One bar split by outcome, a hairline gap between the parts.
struct SplitBar: View {
  let parts: [(Int, Color)]
  var height: CGFloat = 4

  var body: some View {
    let total = max(1, parts.reduce(0) { $0 + $1.0 })
    GeometryReader { geo in
      let shown = parts.filter { $0.0 > 0 }
      let gaps = CGFloat(max(0, shown.count - 1)) * 2
      HStack(spacing: 2) {
        ForEach(Array(shown.enumerated()), id: \.offset) { _, p in
          Rectangle().fill(p.1).frame(width: max(2, (geo.size.width - gaps) * CGFloat(p.0) / CGFloat(total)))
        }
      }
    }
    .frame(height: height)
    .clipShape(RoundedRectangle(cornerRadius: 1))
  }
}

/// A dot per repetition, coloured by outcome, the chosen one ringed; pending ones breathe.
struct RepDots: View {
  let outcomes: [String]
  var pending = 0
  var selected: Int? = nil
  var onSelect: ((Int) -> Void)? = nil

  var body: some View {
    HStack(spacing: 2) {
      ForEach(Array(outcomes.enumerated()), id: \.offset) { i, outcome in
        let tone = Tone(outcome)
        Circle()
          .fill(tone.color)
          .frame(width: 7, height: 7)
          .padding(4)
          .overlay(Circle().strokeBorder(selected == i + 1 ? Theme.text.opacity(0.7) : .clear, lineWidth: 1))
          .contentShape(Circle())
          .onTapGesture { onSelect?(i + 1) }
          .help("Repetition \(i + 1): \(Tone.word(outcome).lowercased())")
      }
      ForEach(0..<max(0, pending), id: \.self) { _ in
        Circle()
          .strokeBorder(Theme.accent, lineWidth: 1)
          .frame(width: 7, height: 7)
          .padding(4)
          .phaseAnimator([0.3, 1]) { view, phase in view.opacity(phase) } animation: { _ in .easeInOut(duration: 0.7) }
      }
    }
  }
}

/// Fades a view in when it first appears, after `delay`.
struct Rise: ViewModifier {
  var delay: Double = 0
  @State private var shown = false

  func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown ? 0 : 4)
      .onAppear {
        withAnimation(.easeOut(duration: 0.35).delay(delay)) { shown = true }
      }
  }
}

extension View {
  func rise(_ delay: Double = 0) -> some View { modifier(Rise(delay: delay)) }
}

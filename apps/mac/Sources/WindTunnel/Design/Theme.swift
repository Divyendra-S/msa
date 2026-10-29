import SwiftUI

/// The look: a dark instrument panel. Monospaced type, hairline boxes with their titles set into
/// the border (as in a terminal UI), one cold accent for airflow and live things, and outcome colours.
enum Theme {
  static let bg = Color(hex: 0x09090B)
  static let surface = Color(hex: 0x0F0F12)
  static let raised = Color(hex: 0x16161A)
  static let hover = Color(hex: 0x1C1C21)
  static let line = Color.white.opacity(0.075)
  static let lineStrong = Color.white.opacity(0.14)

  static let text = Color(hex: 0xECECEF)
  static let dim = Color(hex: 0xA0A0AA)
  static let faint = Color(hex: 0x62626C)
  static let ghost = Color(hex: 0x3A3A42)

  /// Airflow: live, running, selected.
  static let accent = Color(hex: 0x7DE3F4)
  static let pass = Color(hex: 0x62E39A)
  static let fail = Color(hex: 0xFF6166)
  static let flaky = Color(hex: 0xFFC857)
  static let error = Color(hex: 0xC69CFF)

  /// Actors in a run (browser tabs, webhooks), in the order they appear.
  static let actors: [Color] = [Color(hex: 0x7DE3F4), Color(hex: 0xF7A8D8), Color(hex: 0xB9F27C), Color(hex: 0xFFB86B), Color(hex: 0xA6B4FF)]

  static func actor(_ i: Int) -> Color { actors[((i % actors.count) + actors.count) % actors.count] }

  static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }

  static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .default)
  }

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

/// pass/ok → pass, fail/broken → fail, flaky → flaky, error → error, running → accent, others muted.
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
    case .muted: Theme.faint
    }
  }

  /// One character for an outcome, for strips and lists.
  var glyph: String {
    switch self {
    case .pass: "●"
    case .fail: "✗"
    case .flaky: "▲"
    case .error: "■"
    case .live: "○"
    case .muted: "○"
    }
  }
}

// MARK: - Text styles

extension View {
  /// Small caps label: `RULES BROKEN`.
  func label(_ color: Color = Theme.faint) -> some View {
    font(Theme.mono(10, .medium)).tracking(1.4).foregroundStyle(color).textCase(.uppercase)
  }
}

/// `── TITLE ─────────── trailing` : a section rule.
struct SectionRule: View {
  let title: String
  var trailing: String? = nil
  var color: Color = Theme.faint

  var body: some View {
    HStack(spacing: 8) {
      Text(title).label(color)
      Rectangle().fill(Theme.line).frame(height: 1)
      if let trailing { Text(trailing).font(Theme.mono(10)).foregroundStyle(Theme.faint) }
    }
  }
}

/// A box with its title set into the top border, as terminal UIs draw them:
/// ╭─ TITLE ─────────╮
struct Panel<Content: View, Accessory: View>: View {
  let title: String
  var tint: Color = Theme.lineStrong
  var titleColor: Color = Theme.dim
  var padding: CGFloat = 14
  @ViewBuilder var accessory: () -> Accessory
  @ViewBuilder var content: () -> Content

  init(
    _ title: String, tint: Color = Theme.lineStrong, titleColor: Color = Theme.dim, padding: CGFloat = 14,
    @ViewBuilder accessory: @escaping () -> Accessory = { EmptyView() },
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.title = title
    self.tint = tint
    self.titleColor = titleColor
    self.padding = padding
    self.accessory = accessory
    self.content = content
  }

  var body: some View {
    content()
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, padding)
      .padding(.top, padding + 4)
      .padding(.bottom, padding)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.surface.opacity(0.55)))
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(tint, lineWidth: 1))
      .overlay(alignment: .top) {
        HStack(spacing: 0) {
          HStack(spacing: 6) {
            Text("─").foregroundStyle(tint)
            Text(title).label(titleColor)
          }
          .font(Theme.mono(10))
          .padding(.horizontal, 4)
          .background(Theme.bg)
          Spacer(minLength: 12)
          if Accessory.self != EmptyView.self {
            accessory()
              .padding(.horizontal, 6)
              .background(Theme.bg)
          }
        }
        .padding(.horizontal, 10)
        .frame(height: 14)
        .offset(y: -7)
      }
      .padding(.top, 7)
  }
}

/// `[ FAIL ]`
struct OutcomeBadge: View {
  let outcome: String
  var large = false

  var body: some View {
    let tone = Tone(outcome)
    HStack(spacing: large ? 6 : 4) {
      if tone == .live { BrailleSpinner(color: tone.color) }
      Text(outcome.uppercased())
    }
    .font(Theme.mono(large ? 12 : 9.5, .bold))
    .tracking(large ? 2 : 1.2)
    .foregroundStyle(tone.color)
    .padding(.horizontal, large ? 10 : 6)
    .padding(.vertical, large ? 5 : 2.5)
    .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(tone.color.opacity(0.11)))
    .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(tone.color.opacity(0.35), lineWidth: 1))
    .fixedSize()
  }
}

/// A pill-shaped key=value chip.
struct Chip: View {
  let text: String
  var color: Color = Theme.dim

  var body: some View {
    Text(text)
      .font(Theme.mono(10.5))
      .foregroundStyle(color)
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Theme.raised))
      .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

/// The app's buttons: bracketed, monospaced, with a lit border on hover.
struct TermButtonStyle: ButtonStyle {
  var prominent = false
  var color: Color = Theme.accent

  func makeBody(configuration: Configuration) -> some View {
    TermButtonBody(configuration: configuration, prominent: prominent, color: color)
  }
}

private struct TermButtonBody: View {
  let configuration: ButtonStyleConfiguration
  let prominent: Bool
  let color: Color
  @State private var hovering = false
  @Environment(\.isEnabled) private var enabled

  var body: some View {
    configuration.label
      .font(Theme.mono(11.5, prominent ? .semibold : .regular))
      .foregroundStyle(!enabled ? Theme.faint : prominent ? Theme.bg : (hovering ? Theme.text : Theme.dim))
      .padding(.horizontal, 12)
      .padding(.vertical, 6.5)
      .background(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(prominent ? (enabled ? color.opacity(hovering ? 1 : 0.9) : Theme.raised) : (hovering ? Theme.hover : Theme.raised))
      )
      .overlay(
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .strokeBorder(prominent ? Color.clear : (hovering && enabled ? color.opacity(0.45) : Theme.line), lineWidth: 1)
      )
      .shadow(color: prominent && enabled ? color.opacity(hovering ? 0.35 : 0.18) : .clear, radius: hovering ? 12 : 6)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(Theme.snappy, value: hovering)
      .animation(Theme.snappy, value: configuration.isPressed)
      .onHover { hovering = $0 }
      .contentShape(Rectangle())
  }
}

/// A faint grid of dots behind content, like graph paper.
struct DotGrid: View {
  var spacing: CGFloat = 22
  var color: Color = Color.white.opacity(0.045)

  var body: some View {
    Canvas { context, size in
      var path = Path()
      var y: CGFloat = spacing / 2
      while y < size.height {
        var x: CGFloat = spacing / 2
        while x < size.width {
          path.addEllipse(in: CGRect(x: x, y: y, width: 1.4, height: 1.4))
          x += spacing
        }
        y += spacing
      }
      context.fill(path, with: .color(color))
    }
    .allowsHitTesting(false)
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

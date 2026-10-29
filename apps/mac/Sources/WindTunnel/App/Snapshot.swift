import AppKit
import SwiftUI

/// `WindTunnel --snapshot <name> <out.png> [width height]`: renders one view to a PNG and exits.
/// For checking the look without a screen (the views here don't need the bridge).
enum Snapshot {
  static func runIfAsked() -> Bool {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--snapshot"), args.count > i + 2 else { return false }
    let name = args[i + 1]
    let out = URL(fileURLWithPath: args[i + 2])
    let width = args.count > i + 3 ? Double(args[i + 3]) ?? 1100 : 1100
    let height = args.count > i + 4 ? Double(args[i + 4]) ?? 700 : 700
    let view = AnyView(content(name).frame(width: width, height: height).background(name == "icon" ? Color.clear : Theme.ink).environment(\.colorScheme, .dark))
    let renderer = ImageRenderer(content: view)
    renderer.scale = name == "icon" ? 1 : 2
    guard let image = renderer.nsImage, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:])
    else {
      FileHandle.standardError.write(Data("could not render \(name)\n".utf8))
      exit(1)
    }
    try? png.write(to: out)
    return true
  }

  @ViewBuilder
  static func content(_ name: String) -> some View {
    switch name {
    case "orb":
      AsciiArt(scene: .orb(radius: 0.3), fontSize: 8, time: 12.3)
    case "scan":
      AsciiArt(scene: .scan(radius: 0.44), fontSize: 7, time: 12.3)
    case "icon":
      AppIcon()
    case "parts":
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 16) {
          LogoMark(size: 40)
          RepDots(outcomes: ["broken", "ok", "ok", "error", "broken"], pending: 2, selected: 1)
          OutcomeBadge(outcome: "fail", large: true)
          OutcomeBadge(outcome: "pass")
          OutcomeBadge(outcome: "flaky")
        }
        SplitBar(parts: [(9, Theme.pass), (7, Theme.fail), (1, Theme.flaky)]).frame(width: 300)
        Panel("Rules broken", accessory: { Text("3") }) {
          Text("one-order-per-cart").font(Theme.mono(12)).foregroundStyle(Theme.text)
        }
        .frame(width: 400)
      }
      .padding(40)
    default:
      Text("no snapshot \(name)").foregroundStyle(.white)
    }
  }
}

/// The app icon: the orb in its stream of air, drawn in characters on a dark glass tile.
/// Rendered to AppIcon.icns by build.sh.
struct AppIcon: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 185, style: .continuous)
        .fill(LinearGradient(colors: [Color(hex: 0x1A1B24), Color(hex: 0x08090D)], startPoint: .top, endPoint: .bottom))
      RadialGradient(colors: [Theme.lavender.opacity(0.18), .clear], center: UnitPoint(x: 0.3, y: 0.2), startRadius: 0, endRadius: 520)
        .clipShape(RoundedRectangle(cornerRadius: 185, style: .continuous))
      AsciiArt(scene: .orb(center: UnitPoint(x: 0.5, y: 0.5), radius: 0.31), fontSize: 17, lineHeight: 1.0, time: 7.4)
        .padding(40)
        .mask(RoundedRectangle(cornerRadius: 160, style: .continuous).padding(40))
      RoundedRectangle(cornerRadius: 185, style: .continuous)
        .strokeBorder(LinearGradient(colors: [.white.opacity(0.24), .white.opacity(0.04)], startPoint: .top, endPoint: .bottom), lineWidth: 5)
    }
    .padding(100)
    .frame(width: 1024, height: 1024)
  }
}

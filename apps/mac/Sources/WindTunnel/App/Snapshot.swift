import AppKit
import SwiftUI

/// `WindTunnel --snapshot <name> <out.png> [width height]`: renders one view to a PNG and exits.
/// Names: glow (at time $T if set), parts, icon. LIGHT=1 renders it light.
/// For checking the look without a screen (the views here don't need the bridge).
enum Snapshot {
  static func runIfAsked() -> Bool {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: "--snapshot"), args.count > i + 2 else { return false }
    let name = args[i + 1]
    let out = URL(fileURLWithPath: args[i + 2])
    let width = args.count > i + 3 ? Double(args[i + 3]) ?? 1100 : 1100
    let height = args.count > i + 4 ? Double(args[i + 4]) ?? 700 : 700
    // LIGHT=1 renders it light.
    let light = ProcessInfo.processInfo.environment["LIGHT"] == "1" && name != "icon"
    let view = AnyView(content(name).frame(width: width, height: height).background(name == "icon" ? Color.clear : Theme.ink).environment(\.colorScheme, light ? .light : .dark))
    let renderer = ImageRenderer(content: view)
    renderer.scale = name == "icon" ? 1 : 2
    var image: NSImage?
    NSAppearance(named: light ? .aqua : .darkAqua)!.performAsCurrentDrawingAppearance { image = renderer.nsImage }
    guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
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
    case "glow":
      Glow(time: Double(ProcessInfo.processInfo.environment["T"] ?? "") ?? 0)
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
        SplitBar(parts: [(9, Theme.accent), (7, Theme.fail), (1, Theme.flaky)]).frame(width: 300)
        Panel("Broken rule", accessory: { Text("3") }) {
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

/// The app icon: the mark, three lines of air through the tunnel's throat, on a dark tile with a
/// faint glow of the hue behind it. Rendered to AppIcon.icns by build.sh.
struct AppIcon: View {
  var body: some View {
    let tile = RoundedRectangle(cornerRadius: 185, style: .continuous)
    ZStack {
      tile.fill(LinearGradient(colors: [Color(hex: 0x17181F), Color(hex: 0x0A0B0E)], startPoint: .top, endPoint: .bottom))
      RadialGradient(colors: [Theme.accent.opacity(0.16), .clear], center: .center, startRadius: 0, endRadius: 380)
        .clipShape(tile)
      LogoMark(size: 520)
      tile.strokeBorder(Color.white.opacity(0.1), lineWidth: 4)
    }
    .padding(100)
    .frame(width: 1024, height: 1024)
  }
}

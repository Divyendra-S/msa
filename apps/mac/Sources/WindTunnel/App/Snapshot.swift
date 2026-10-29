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
    let view = AnyView(content(name).frame(width: width, height: height).background(name == "icon" ? Color.clear : Theme.bg).environment(\.colorScheme, .dark))
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
    case "airflow":
      AirflowField(time: 12.3)
    case "icon":
      AppIcon()
    case "logo":
      VStack(alignment: .leading, spacing: 24) {
        AsciiLogo(fontSize: 10, animated: false)
        HStack(spacing: 16) {
          AsciiBar(value: 0.63)
          RepStrip(outcomes: ["broken", "ok", "ok", "error", "broken"], pending: 2, selected: 1)
          OutcomeBadge(outcome: "fail", large: true)
          OutcomeBadge(outcome: "pass")
          OutcomeBadge(outcome: "flaky")
        }
        Panel("Rules broken") {
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

/// The app icon: the airflow in a dark tile. Rendered to AppIcon.icns by build.sh.
struct AppIcon: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 185, style: .continuous)
        .fill(LinearGradient(colors: [Color(hex: 0x15161B), Color(hex: 0x070709)], startPoint: .top, endPoint: .bottom))
      AirflowField(fontSize: 30, color: Theme.accent, center: CGPoint(x: 0.36, y: 0.5), radius: 0.17, lines: 9, time: 7.4)
        .padding(70)
        .mask(RoundedRectangle(cornerRadius: 160, style: .continuous).padding(40))
      RoundedRectangle(cornerRadius: 185, style: .continuous)
        .strokeBorder(LinearGradient(colors: [.white.opacity(0.22), .white.opacity(0.04)], startPoint: .top, endPoint: .bottom), lineWidth: 6)
    }
    .padding(100)
    .frame(width: 1024, height: 1024)
  }
}

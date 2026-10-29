import AppKit
import SwiftUI

@main
struct WindTunnelMain {
  static func main() {
    if Snapshot.runIfAsked() { return }
    WindTunnelApp.main()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Also a proper app when started as a bare executable (swift run).
    NSApp.setActivationPolicy(.regular)
    NSApp.activate()
  }

  func applicationWillTerminate(_ notification: Notification) {
    AppModel.shared.shutdown()
  }
}

struct WindTunnelApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel.shared

  var body: some Scene {
    Window("Wind Tunnel", id: "main") {
      RootView()
        .environment(model)
        .frame(minWidth: 1120, minHeight: 720)
        .onAppear { if model.phase == .welcome { model.start() } }
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1440, height: 900)
    .commands {
      CommandGroup(replacing: .newItem) {
        Button("Open Project…") { model.chooseProject() }.keyboardShortcut("o")
        Button("Close Project") { model.closeProject() }.keyboardShortcut("w", modifiers: [.command, .shift]).disabled(model.phase == .welcome)
        Button("Reconnect") { model.reconnect() }.keyboardShortcut("r", modifiers: [.command, .shift])
      }
      CommandMenu("Run") {
        Button("Run All Experiments") { model.runExperiments([]) }.keyboardShortcut("r").disabled(model.api == nil || model.runningJob != nil)
        Button("Hunt") { model.section = .hunt }.keyboardShortcut("h", modifiers: [.command, .shift])
      }
    }

    MenuBarExtra {
      MenuBarView().environment(model)
    } label: {
      Image(systemName: model.runningHunt != nil || model.runningJob != nil ? "wind.circle.fill" : "wind")
    }
    .menuBarExtraStyle(.window)

    Settings {
      SettingsView().environment(model)
    }
  }
}

import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      Backdrop()
      switch model.phase {
      case .connected:
        MainView().transition(.opacity)
      case .connecting(let path):
        ConnectingView(path: path).transition(.opacity)
      case .welcome:
        WelcomeView(error: nil).transition(.opacity)
      case .failed(let message):
        WelcomeView(error: message).transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.35), value: model.phase)
    .preferredColorScheme(.dark)
    .tint(Theme.accent)
  }
}

// MARK: - Main window

struct MainView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 0) {
      Sidebar()
      Hairline(vertical: true)
      VStack(spacing: 0) {
        TopBar()
        ZStack {
          switch model.section {
          case .overview: OverviewView()
          case .runs: RunsSplit()
          case .experiments: ExperimentsSplit()
          case .hunt: HuntView()
          case .usage: UsageView()
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .id(model.section)
        .transition(.opacity.combined(with: .offset(y: 6)))
      }
      .animation(Theme.spring, value: model.section)
    }
    .overlay(alignment: .bottom) { NoticeToast() }
    .ignoresSafeArea()
  }
}

/// The page title, what's running, and Run all.
struct TopBar: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 12) {
      Text(model.section.title)
        .font(Theme.sans(15, .semibold))
        .foregroundStyle(Theme.text)
        .contentTransition(.opacity)
      Spacer(minLength: 10)
      if let job = model.runningJob {
        HStack(spacing: 8) {
          BrailleSpinner(size: 10)
          Text(job.experiments.isEmpty ? "Running all" : "Running \(job.experiments.joined(separator: ", "))")
            .font(Theme.sans(12)).foregroundStyle(Theme.dim).lineLimit(1)
          Button("Stop") { model.stopJob(job.id) }
            .buttonStyle(.plain)
            .font(Theme.sans(12, .medium))
            .foregroundStyle(Theme.fail)
        }
        .frame(maxWidth: 340)
        .transition(.opacity)
      }
      Button {
        model.runExperiments([])
      } label: {
        Label("Run all", systemImage: "play.fill")
      }
      .buttonStyle(ActionButtonStyle())
      .disabled(model.runningJob != nil || model.experiments.isEmpty)
      .help("Run every experiment against the working tree. No model involved.")
    }
    .padding(.leading, 24)
    .padding(.trailing, 16)
    .frame(height: 52)
    .contentShape(Rectangle())
    .gesture(WindowDragGesture())
    .animation(Theme.spring, value: model.runningJob?.id)
  }
}

struct Sidebar: View {
  @Environment(AppModel.self) private var model
  @Namespace private var selection

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      // The traffic lights sit here.
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
      ProjectSwitcher().padding(.horizontal, 8)
      VStack(spacing: 2) {
        ForEach(Array(Pane.allCases.enumerated()), id: \.element) { i, section in
          SidebarItem(section: section, index: i + 1, selected: model.section == section, namespace: selection) {
            withAnimation(Theme.spring) { model.section = section }
          }
        }
      }
      .padding(.horizontal, 8)
      .padding(.top, 12)
      Spacer(minLength: 20)
      HStack(spacing: 6) {
        LiveDot(on: model.live)
        Text(model.live ? "Live" : "Offline").font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.faint)
        Spacer()
        SettingsLink {
          Image(systemName: "gearshape").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.faint)
            .frame(width: 26, height: 26).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Settings")
      }
      .padding(.leading, 12)
      .padding(.trailing, 8)
      .padding(.bottom, 10)
      .help(bridgeHelp)
    }
    .frame(width: 210)
    .background(Color.white.opacity(0.02))
  }

  private var bridgeHelp: String {
    guard let info = model.info else { return "Not connected" }
    return "Bridge on 127.0.0.1:\(info.port)\(info.reused ? ", shared" : "")\n\(model.toolchainDescription)"
  }
}

/// The open project, and a menu to switch or close it.
private struct ProjectSwitcher: View {
  @Environment(AppModel.self) private var model
  @State private var hovering = false

  var body: some View {
    Menu {
      ForEach(model.recents, id: \.self) { path in
        Button((path as NSString).lastPathComponent) { model.open(project: path) }
      }
      Divider()
      Button("Open Project…") { model.chooseProject() }
      Button("Show in Finder") { if let root = model.status?.project.root { model.reveal(root) } }
      Button("Close Project") { model.closeProject() }
    } label: {
      HStack(spacing: 9) {
        LogoMark(size: 18).frame(width: 22)
        VStack(alignment: .leading, spacing: 1) {
          Text(model.status?.project.name ?? "—").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
          Text(Fmt.tilde(model.status?.project.root ?? "")).font(Theme.sans(10.5)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.head)
        }
        Spacer(minLength: 0)
        Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.faint)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 6)
      .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .onHover { hovering = $0 }
    .animation(Theme.snappy, value: hovering)
  }
}

private struct SidebarItem: View {
  @Environment(AppModel.self) private var model
  let section: Pane
  let index: Int
  let selected: Bool
  let namespace: Namespace.ID
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: section.symbol)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(selected ? Theme.accent : Theme.faint)
          .frame(width: 18)
        Text(section.title)
          .font(Theme.sans(13, selected ? .semibold : .regular))
          .foregroundStyle(selected || hovering ? Theme.text : Theme.dim)
        Spacer()
        if section == .hunt, model.runningHunt != nil {
          LiveDot(on: true)
        } else if let count {
          Text(count).font(Theme.sans(11, .medium)).monospacedDigit().foregroundStyle(Theme.faint).contentTransition(.numericText())
        }
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .background {
        if selected {
          RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous)
            .fill(Theme.selection)
            .matchedGeometryEffect(id: "sel", in: namespace)
        } else if hovering {
          RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(Theme.hover)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .keyboardShortcut(KeyEquivalent(Character("\(index)")), modifiers: .command)
    .onHover { hovering = $0 }
  }

  private var count: String? {
    switch section {
    case .runs: model.runs.isEmpty ? nil : "\(model.runs.count)"
    case .experiments: model.experiments.isEmpty ? nil : "\(model.experiments.count)"
    default: nil
    }
  }
}

struct NoticeToast: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      if let notice = model.notice {
        HStack(spacing: 10) {
          Image(systemName: "exclamationmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.flaky)
          Text(notice).font(Theme.sans(12.5)).foregroundStyle(Theme.text).lineLimit(3)
          Button {
            model.notice = nil
          } label: {
            Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glass(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
        .padding(.bottom, 24)
        .frame(maxWidth: 620)
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .task(id: notice) {
          try? await Task.sleep(for: .seconds(7))
          model.notice = nil
        }
      }
    }
    .animation(Theme.spring, value: model.notice)
  }
}

// MARK: - Welcome and connecting

struct WelcomeView: View {
  @Environment(AppModel.self) private var model
  let error: String?

  var body: some View {
    ZStack {
      AsciiArt(scene: .tunnel(throat: 0.66, squeeze: 0.52, spacing: 3.4), fontSize: 9, lineHeight: 1.1)
        .padding(.vertical, 40)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0.3), .init(color: .black, location: 0.55)], startPoint: .leading, endPoint: .trailing))
      HStack {
        VStack(alignment: .leading, spacing: 0) {
          Spacer()
          LogoMark(size: 34)
            .padding(.bottom, 26)
            .rise()
          Text("Wind Tunnel")
            .font(.system(size: 44, weight: .semibold))
            .tracking(-1.1)
            .foregroundStyle(Theme.text)
            .rise(0.04)
          Text("Find the bugs that only happen\nwhen things happen at once.")
            .font(Theme.sans(17))
            .foregroundStyle(Theme.dim)
            .lineSpacing(3)
            .padding(.top, 10)
            .rise(0.08)
          if let error {
            HStack(alignment: .top, spacing: 10) {
              Rectangle().fill(Theme.fail).frame(width: 2)
              Text(error).font(Theme.sans(12.5)).foregroundStyle(Theme.text).textSelection(.enabled)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 480, alignment: .leading)
            .padding(.top, 24)
          }
          HStack(spacing: 8) {
            Button {
              model.chooseProject()
            } label: {
              Text("Open Folder…")
            }
            .buttonStyle(ActionButtonStyle(prominent: true))
            .keyboardShortcut("o", modifiers: .command)
            if error != nil, model.projectPath != nil {
              Button("Try Again") { model.reconnect() }.buttonStyle(ActionButtonStyle())
            } else if let last = model.recents.first {
              Button {
                model.open(project: last)
              } label: {
                HStack(spacing: 8) {
                  Text("Open \((last as NSString).lastPathComponent)")
                  Text("↩").font(Theme.sans(11)).foregroundStyle(Theme.faint)
                }
              }
              .buttonStyle(ActionButtonStyle())
              .keyboardShortcut(.defaultAction)
            }
          }
          .padding(.top, 32)
          .rise(0.12)
          if !model.recents.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
              Text("Recent").label().padding(.leading, 8).padding(.bottom, 6)
              ForEach(model.recents.prefix(4), id: \.self) { path in
                RecentRow(path: path)
              }
            }
            .frame(width: 360, alignment: .leading)
            .padding(.top, 44)
            .padding(.leading, -8)
            .rise(0.16)
          }
          Spacer()
        }
        .padding(.leading, 80)
        Spacer()
      }
    }
    .overlay(alignment: .top) {
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
    }
    .ignoresSafeArea()
  }
}

private struct RecentRow: View {
  @Environment(AppModel.self) private var model
  let path: String
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 10) {
      Text((path as NSString).lastPathComponent).font(Theme.sans(13)).foregroundStyle(hovering ? Theme.text : Theme.text.opacity(0.85))
      Text(Fmt.tilde((path as NSString).deletingLastPathComponent)).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
      Spacer()
      if hovering {
        Button {
          model.forget(path)
        } label: {
          Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
        }
        .buttonStyle(.plain)
        .help("Remove from Recent")
      }
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 8)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onTapGesture { model.open(project: path) }
    .onHover { hovering = $0 }
  }
}

struct ConnectingView: View {
  let path: String

  var body: some View {
    VStack(spacing: 16) {
      AsciiArt(scene: .tunnel(squeeze: 0.5, spacing: 3, walls: false), fontSize: 8, fps: 24)
        .frame(width: 440, height: 150)
      HStack(spacing: 9) {
        BrailleSpinner(size: 12)
        Text("Opening \((path as NSString).lastPathComponent)").font(Theme.sans(13)).foregroundStyle(Theme.dim)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay(alignment: .top) {
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
    }
    .ignoresSafeArea()
  }
}

/// A view with nothing in it yet: a little air and a line.
struct EmptyState: View {
  let title: String
  let text: String

  var body: some View {
    VStack(spacing: 12) {
      AsciiArt(scene: .tunnel(squeeze: 0.45, spacing: 2.6, walls: false, dust: false), fontSize: 7, fps: 16)
        .frame(width: 200, height: 70)
        .padding(.bottom, 6)
      Text(title).font(Theme.sans(14, .semibold)).foregroundStyle(Theme.text)
      Text(text).font(Theme.sans(12.5)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).frame(maxWidth: 340)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

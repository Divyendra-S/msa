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
      case .setup:
        SetupView().transition(.opacity)
      case .failed(let message):
        WelcomeView(error: message).transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.35), value: model.phase)
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
    .padding(.leading, Theme.gutter)
    .padding(.trailing, Theme.gutter)
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
        Text(model.live ? "Live" : "Offline").font(Theme.sans(11, .medium)).foregroundStyle(Theme.faint)
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
    .background(Theme.overlay(0.02))
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
          Text(Fmt.tilde(model.status?.project.root ?? "")).font(Theme.sans(11)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.head)
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
          Text(notice).font(Theme.sans(12)).foregroundStyle(Theme.text).lineLimit(3)
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

/// The start page: what the app is for, the last project one key away, the rest listed, over the
/// same trace as the first run.
struct WelcomeView: View {
  @Environment(AppModel.self) private var model
  let error: String?

  var body: some View {
    ZStack {
      Glow(corner: .bottomTrailing, strength: 0.5)
      RequestTrace().mask(StartScreenFade()).opacity(0.85)
      VStack(alignment: .leading, spacing: 0) {
        Brand().padding(.top, 46)
        Spacer(minLength: 32)
        Text("Find the bugs that only happen when things happen at once.")
          .font(Theme.display).tracking(Theme.displayTracking)
          .foregroundStyle(Theme.text)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 500, alignment: .leading)
          .rise()
        if let error {
          HStack(alignment: .top, spacing: 12) {
            Rectangle().fill(Theme.fail).frame(width: 2)
            VStack(alignment: .leading, spacing: 4) {
              Text("Couldn't open the project").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
              Text(error).font(Theme.sans(12)).foregroundStyle(Theme.dim).textSelection(.enabled).lineLimit(4)
            }
          }
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 460, alignment: .leading)
          .padding(.top, 28)
        }
        HStack(spacing: 10) {
          if error != nil, model.projectPath != nil {
            Button("Try Again") { model.reconnect() }
              .buttonStyle(ActionButtonStyle(prominent: true, large: true))
              .keyboardShortcut(.defaultAction)
          } else if let last = model.recents.first {
            Button {
              model.open(project: last)
            } label: {
              HStack(spacing: 8) {
                Text("Open \((last as NSString).lastPathComponent)")
                KeyHint("↩")
              }
            }
            .buttonStyle(ActionButtonStyle(prominent: true, large: true))
            .keyboardShortcut(.defaultAction)
          }
          Button {
            model.chooseProject()
          } label: {
            HStack(spacing: 8) {
              Text("Open Folder…")
              KeyHint("⌘O")
            }
          }
          .buttonStyle(ActionButtonStyle(prominent: model.recents.isEmpty && error == nil, large: true))
          .keyboardShortcut("o", modifiers: .command)
        }
        .padding(.top, 32)
        .rise(0.06)
        if model.recents.count > 1 || (error != nil && !model.recents.isEmpty) {
          VStack(alignment: .leading, spacing: 0) {
            Text("Recent").label(Theme.ghost).padding(.bottom, 8)
            ForEach(model.recents.prefix(5), id: \.self) { path in
              RecentRow(path: path, onRemove: { model.forget(path) }) { model.open(project: path) }
            }
          }
          .frame(width: 420, alignment: .leading)
          .padding(.top, 52)
          .rise(0.12)
        }
        Spacer(minLength: 32)
        Button {
          model.setup.folder = nil
          model.beginSetup(at: .app)
        } label: {
          Label("Set Up a New App…", systemImage: "plus")
        }
        .buttonStyle(LinkButtonStyle())
        .padding(.bottom, 30)
      }
      .padding(.leading, Theme.startMargin)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
    .overlay(alignment: .top) {
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
    }
    .ignoresSafeArea()
  }
}

/// A folder opened before: its name, where it is, and on hover a way to drop it from the list.
struct RecentRow: View {
  let path: String
  var onRemove: (() -> Void)? = nil
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "folder").font(.system(size: 12)).foregroundStyle(hovering ? Theme.dim : Theme.faint).frame(width: 16)
      Text((path as NSString).lastPathComponent).font(Theme.sans(13, .medium)).foregroundStyle(hovering ? Theme.text : Theme.text.opacity(0.88))
      Text(Fmt.tilde((path as NSString).deletingLastPathComponent)).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 8)
      if hovering {
        if let onRemove {
          Button(action: onRemove) {
            Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
          }
          .buttonStyle(LinkButtonStyle())
          .help("Remove from Recent")
        }
        Image(systemName: "arrow.right").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.dim)
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 34)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .padding(.horizontal, -10)
    .onTapGesture(perform: action)
    .onHover { hovering = $0 }
    .help(Fmt.tilde(path))
  }
}

/// While the bridge starts: the mark, and what's opening.
struct ConnectingView: View {
  let path: String

  var body: some View {
    ZStack {
      Glow(corner: .bottomTrailing, strength: 0.35)
      VStack(spacing: 20) {
        LogoMark(size: 30)
        HStack(spacing: 10) {
          DitherBar(width: 28, height: 4)
          Text("Opening \((path as NSString).lastPathComponent)").font(Theme.sans(13)).foregroundStyle(Theme.dim)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay(alignment: .top) {
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
    }
    .ignoresSafeArea()
  }
}

/// A view with nothing in it yet: what would be here, and how it gets there.
struct EmptyState: View {
  let title: String
  let text: String

  var body: some View {
    VStack(spacing: 8) {
      Text(title).font(Theme.sans(15, .semibold)).foregroundStyle(Theme.text)
      Text(text).font(Theme.sans(13)).foregroundStyle(Theme.faint).multilineTextAlignment(.center).lineSpacing(2).frame(maxWidth: 340)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

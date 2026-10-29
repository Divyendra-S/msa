import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
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
    VStack(spacing: 0) {
      HeaderBar()
      HStack(spacing: 0) {
        Sidebar()
        Rectangle().fill(Theme.line).frame(width: 1)
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
      StatusBar()
    }
    .overlay(alignment: .bottom) { NoticeToast() }
    .ignoresSafeArea()
  }
}

/// The title bar: traffic lights, the project, live state and the main actions.
struct HeaderBar: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    HStack(spacing: 14) {
      Color.clear.frame(width: 64)
      HStack(spacing: 9) {
        Button {
          model.closeProject()
        } label: {
          HStack(spacing: 9) {
            LogoMark(size: 18)
            Text("wind tunnel").font(Theme.mono(12.5, .semibold)).foregroundStyle(Theme.text)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Back to the start page")
        Text("/").font(Theme.mono(12.5)).foregroundStyle(Theme.ghost)
        Menu {
          ForEach(model.recents, id: \.self) { path in
            Button(Fmt.tilde(path)) { model.open(project: path) }
          }
          Divider()
          Button("Open Project…") { model.chooseProject() }
          Button("Close Project") { model.closeProject() }
        } label: {
          HStack(spacing: 4) {
            Text(model.status?.project.name ?? "—").font(Theme.mono(12.5)).foregroundStyle(Theme.accent)
            Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.faint)
          }
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        LiveDot(on: model.live).help(model.live ? "Live: updates as runs start and finish" : "Not connected")
      }
      Spacer(minLength: 10)
      if let job = model.runningJob {
        HStack(spacing: 8) {
          BrailleSpinner()
          Text("running \(job.experiments.isEmpty ? "all" : job.experiments.joined(separator: ", "))")
            .font(Theme.mono(11)).foregroundStyle(Theme.dim).lineLimit(1)
          Button("stop") { model.stopJob(job.id) }.buttonStyle(.plain).font(Theme.mono(11)).foregroundStyle(Theme.fail)
        }
        .transition(.move(edge: .top).combined(with: .opacity))
      }
      Button {
        model.runExperiments([])
      } label: {
        Label("Run all", systemImage: "play.fill").labelStyle(.titleAndIcon)
      }
      .buttonStyle(TermButtonStyle())
      .disabled(model.runningJob != nil || model.experiments.isEmpty)
      .help("Run every experiment on the working tree (no model involved)")
      Button {
        model.section = .hunt
      } label: {
        Label(model.runningHunt == nil ? "Hunt" : "Hunting", systemImage: "scope")
      }
      .buttonStyle(TermButtonStyle(prominent: true))
    }
    .padding(.horizontal, 14)
    .frame(height: 46)
    .background(Theme.bg)
    .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    .gesture(WindowDragGesture())
    .animation(Theme.spring, value: model.runningJob?.id)
  }
}

/// The mark: air bending round a cylinder.
struct LogoMark: View {
  var size: CGFloat = 18
  var color: Color = Theme.accent

  var body: some View {
    Canvas { context, s in
      let w = s.width, h = s.height
      let line = max(1.3, w * 0.085)
      var p = Path()
      // Over the top and under the bottom, bending round the body; the middle stream meets it.
      p.move(to: CGPoint(x: 0.04 * w, y: 0.24 * h))
      p.addCurve(to: CGPoint(x: 0.96 * w, y: 0.2 * h), control1: CGPoint(x: 0.5 * w, y: 0.24 * h), control2: CGPoint(x: 0.56 * w, y: 0.06 * h))
      p.move(to: CGPoint(x: 0.04 * w, y: 0.76 * h))
      p.addCurve(to: CGPoint(x: 0.96 * w, y: 0.8 * h), control1: CGPoint(x: 0.5 * w, y: 0.76 * h), control2: CGPoint(x: 0.56 * w, y: 0.94 * h))
      p.move(to: CGPoint(x: 0.04 * w, y: 0.5 * h))
      p.addLine(to: CGPoint(x: 0.3 * w, y: 0.5 * h))
      context.stroke(p, with: .color(color.opacity(0.85)), style: StrokeStyle(lineWidth: line, lineCap: .round))
      let r = 0.17 * w
      context.fill(Path(ellipseIn: CGRect(x: 0.55 * w - r, y: 0.5 * h - r, width: 2 * r, height: 2 * r)), with: .color(Theme.text))
    }
    .frame(width: size, height: size)
  }
}

struct Sidebar: View {
  @Environment(AppModel.self) private var model
  @Namespace private var selection

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 0) {
      Text("navigate").label().padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 8)
      VStack(spacing: 2) {
        ForEach(Array(Pane.allCases.enumerated()), id: \.element) { i, section in
          SidebarItem(section: section, index: i + 1, count: count(section), selected: model.section == section, namespace: selection) {
            withAnimation(Theme.spring) { model.section = section }
          }
        }
      }
      .padding(.horizontal, 8)

      Spacer(minLength: 20)

      VStack(alignment: .leading, spacing: 8) {
        SectionRule(title: "project")
        if let s = model.status {
          Text(s.project.name).font(Theme.mono(12, .semibold)).foregroundStyle(Theme.text)
          Text(Fmt.tilde(s.project.root)).font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(2).truncationMode(.middle)
            .onTapGesture { model.reveal(s.project.root) }
            .help("Show in Finder")
          HStack(spacing: 6) {
            Chip(text: "decider \(s.decider ?? "–")")
          }
          if let users = s.users, !users.isEmpty {
            Text("users " + users.joined(separator: " · ")).font(Theme.mono(10)).foregroundStyle(Theme.faint)
          }
        }
      }
      .padding(.horizontal, 18)
      .padding(.bottom, 16)
    }
    .frame(width: 214)
    .background(Theme.bg)
  }

  private func count(_ section: Pane) -> String? {
    switch section {
    case .runs: model.runs.isEmpty ? nil : "\(model.runs.count)"
    case .experiments: model.experiments.isEmpty ? nil : "\(model.experiments.count)"
    case .hunt: model.runningHunt != nil ? "live" : nil
    default: nil
    }
  }
}

private struct SidebarItem: View {
  let section: Pane
  let index: Int
  let count: String?
  let selected: Bool
  let namespace: Namespace.ID
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: section.symbol)
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(selected ? Theme.accent : Theme.dim)
          .frame(width: 18)
          .symbolEffect(.bounce, value: selected)
        Text(section.title.lowercased())
          .font(Theme.mono(12, selected ? .semibold : .regular))
          .foregroundStyle(selected ? Theme.text : (hovering ? Theme.text : Theme.dim))
        Spacer()
        if let count {
          Text(count)
            .font(Theme.mono(10, count == "live" ? .bold : .regular))
            .foregroundStyle(count == "live" ? Theme.accent : Theme.faint)
            .contentTransition(.numericText())
        }
        Text("⌘\(index)").font(Theme.mono(9.5)).foregroundStyle(Theme.ghost).opacity(hovering || selected ? 1 : 0)
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .background {
        if selected {
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Theme.raised)
            .overlay(alignment: .leading) {
              RoundedRectangle(cornerRadius: 1).fill(Theme.accent).frame(width: 2, height: 14).offset(x: -1)
            }
            .matchedGeometryEffect(id: "sel", in: namespace)
        } else if hovering {
          RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.surface)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .keyboardShortcut(KeyEquivalent(Character("\(index)")), modifiers: .command)
    .onHover { hovering = $0 }
  }
}

/// A status line along the bottom, as an editor or tmux draws one.
struct StatusBar: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let mode = model.runningHunt != nil ? ("HUNTING", Theme.accent) : model.runningJob != nil ? ("RUNNING", Theme.flaky) : ("READY", Theme.pass)
    HStack(spacing: 0) {
      Text(" \(mode.0) ")
        .font(Theme.mono(10, .bold))
        .tracking(1.2)
        .foregroundStyle(Theme.bg)
        .padding(.horizontal, 6)
        .frame(maxHeight: .infinity)
        .background(mode.1)
        .contentTransition(.numericText())
      segment(model.live ? "● live" : "○ offline", color: model.live ? Theme.accent : Theme.faint)
      if let info = model.info {
        segment("bridge 127.0.0.1:\(info.port)\(info.reused ? " (shared)" : "")")
      }
      segment("\(model.runs.count) runs")
      let latest = model.latestByExperiment.values
      let failing = latest.filter { $0.outcome == "fail" }.count
      if failing > 0 { segment("\(failing) failing", color: Theme.fail) }
      let flaky = latest.filter { $0.outcome == "flaky" }.count
      if flaky > 0 { segment("\(flaky) flaky", color: Theme.flaky) }
      Spacer()
      if let usage = model.usage {
        let tokens = usage.jobs.reduce(0) { $0 + $1.tokens }
        let usd = usage.jobs.reduce(0) { $0 + $1.usd }
        segment("returned \(Fmt.kilo(tokens)) tok · \(Fmt.usd(usd))")
      }
      segment(model.hasAnthropicKey ? "claude key ✓" : "claude: your login", color: model.hasAnthropicKey ? Theme.pass : Theme.faint)
      segment(model.toolchainDescription)
    }
    .font(Theme.mono(10))
    .frame(height: 22)
    .background(Theme.surface)
    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    .animation(Theme.spring, value: mode.0)
  }

  private func segment(_ text: String, color: Color = Theme.faint) -> some View {
    HStack(spacing: 0) {
      Text(text).foregroundStyle(color).lineLimit(1).padding(.horizontal, 10)
      Rectangle().fill(Theme.line).frame(width: 1, height: 12)
    }
  }
}

struct NoticeToast: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ZStack {
      if let notice = model.notice {
        HStack(spacing: 10) {
          Text("!").font(Theme.mono(12, .bold)).foregroundStyle(Theme.bg).frame(width: 18, height: 18).background(Circle().fill(Theme.flaky))
          Text(notice).font(Theme.mono(11.5)).foregroundStyle(Theme.text).lineLimit(3)
          Button {
            model.notice = nil
          } label: {
            Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.faint)
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.raised))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.flaky.opacity(0.4)))
        .shadow(color: .black.opacity(0.5), radius: 20, y: 8)
        .padding(.bottom, 40)
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
      AirflowField(fontSize: 11, color: Theme.accent.opacity(0.9), center: CGPoint(x: 0.74, y: 0.44), radius: 0.12, lines: 24)
        .mask(LinearGradient(stops: [.init(color: .black.opacity(0.18), location: 0), .init(color: .black.opacity(0.25), location: 0.42), .init(color: .black, location: 0.62)], startPoint: .leading, endPoint: .trailing))
      VStack(alignment: .leading, spacing: 26) {
        Spacer()
        AsciiLogo(fontSize: 11)
        VStack(alignment: .leading, spacing: 8) {
          Text("Find the bugs that only show up when things happen at the same time.")
            .font(Theme.sans(17, .medium)).foregroundStyle(Theme.text)
          Text("Double submits, duplicate webhooks, two tabs, slow payments: Wind Tunnel runs them as experiments\nagainst your app and a copy of its database, and shows exactly where a run went wrong.")
            .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3)
        }
        if let error {
          HStack(alignment: .top, spacing: 10) {
            Text("✗").font(Theme.mono(13, .bold)).foregroundStyle(Theme.fail)
            Text(error).font(Theme.mono(11.5)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
          .padding(12)
          .frame(maxWidth: 720, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 7).fill(Theme.fail.opacity(0.08)))
          .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Theme.fail.opacity(0.35)))
        }
        HStack(spacing: 12) {
          Button {
            model.chooseProject()
          } label: {
            Label("Open project folder…", systemImage: "folder")
          }
          .buttonStyle(TermButtonStyle(prominent: true))
          .keyboardShortcut("o", modifiers: .command)
          if error != nil, model.projectPath != nil {
            Button("Try again") { model.reconnect() }.buttonStyle(TermButtonStyle())
          } else if let last = model.recents.first {
            Button {
              model.open(project: last)
            } label: {
              Label("Open \((last as NSString).lastPathComponent)", systemImage: "return")
            }
            .buttonStyle(TermButtonStyle())
            .keyboardShortcut(.defaultAction)
          }
        }
        if !model.recents.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            SectionRule(title: "recent").frame(maxWidth: 520)
            ForEach(model.recents, id: \.self) { path in
              RecentRow(path: path)
            }
          }
          .padding(.top, 6)
        }
        Spacer()
        Text("runs on your own agent · Claude Code, Codex or Muse Code · MIT")
          .font(Theme.mono(10)).foregroundStyle(Theme.ghost)
      }
      .padding(.horizontal, 64)
      .padding(.vertical, 40)
      .frame(maxWidth: .infinity, alignment: .leading)
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
      Text(hovering ? "▶" : "·").font(Theme.mono(11)).foregroundStyle(hovering ? Theme.accent : Theme.faint).frame(width: 12)
      Text((path as NSString).lastPathComponent).font(Theme.mono(12, .medium)).foregroundStyle(hovering ? Theme.text : Theme.dim)
      Text(Fmt.tilde(path)).font(Theme.mono(10.5)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
      Spacer()
      if hovering {
        Button {
          model.forget(path)
        } label: {
          Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.faint)
        }
        .buttonStyle(.plain)
        .help("Remove from recents")
      }
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 8)
    .frame(maxWidth: 520)
    .background(RoundedRectangle(cornerRadius: 5).fill(hovering ? Theme.surface : .clear))
    .contentShape(Rectangle())
    .onTapGesture { model.open(project: path) }
    .onHover { hovering = $0 }
    .animation(Theme.snappy, value: hovering)
  }
}

struct ConnectingView: View {
  @Environment(AppModel.self) private var model
  let path: String

  var body: some View {
    ZStack {
      AirflowField(fontSize: 11, color: Theme.accent.opacity(0.7), center: CGPoint(x: 0.5, y: 0.5), radius: 0.09, lines: 30, speed: 1.6)
      VStack(spacing: 14) {
        HStack(spacing: 10) {
          BrailleSpinner(size: 14)
          ScrambleText(text: "starting the bridge", font: Theme.mono(14, .medium))
        }
        Text(Fmt.tilde(path)).font(Theme.mono(11)).foregroundStyle(Theme.dim)
        Text("windtunnel view --json").font(Theme.mono(10)).foregroundStyle(Theme.faint)
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 20)
      .background(RoundedRectangle(cornerRadius: 10).fill(Theme.bg.opacity(0.92)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.lineStrong))
    }
    .ignoresSafeArea()
  }
}

import SwiftUI
import UniformTypeIdentifiers

/// First run, in two screens. Pick the app, beside a trace of requests where two that run at once
/// get caught, the way the bugs it finds do; then the app's code, read by `windtunnel scan` with nothing
/// set up yet, beside what to do next. The Mac is checked quietly meanwhile and only speaks up when
/// something is missing.
struct SetupView: View {
  @Environment(AppModel.self) private var model
  @State private var dropping = false

  var body: some View {
    @Bindable var setup = model.setup
    let picking = setup.step == .app
    ZStack {
      Glow(corner: picking ? .bottomTrailing : .topTrailing, strength: picking ? (dropping ? 0.95 : 0.6) : 0.28)
        .ignoresSafeArea()
      if picking {
        RequestTrace()
          .mask(StartScreenFade())
          .opacity(dropping ? 1 : 0.85)
          .ignoresSafeArea()
          .transition(.opacity)
      }
      Group {
        switch setup.step {
        case .app: PickApp(dropping: dropping)
        case .read: ReadApp()
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .id(setup.step)
      .transition(.opacity)
    }
    .animation(.easeInOut(duration: 0.6), value: dropping)
    .animation(.easeInOut(duration: 0.35), value: setup.step)
    .onDrop(of: [.fileURL], isTargeted: $dropping) { providers in
      guard let provider = providers.first else { return false }
      _ = provider.loadObject(ofClass: URL.self) { url, _ in
        guard let url else { return }
        Task { @MainActor in pick(url.path) }
      }
      return true
    }
    .sheet(isPresented: $setup.showMac) { MacSheet() }
    .overlay(alignment: .top) {
      Color.clear.frame(height: 40).contentShape(Rectangle()).gesture(WindowDragGesture())
    }
    .ignoresSafeArea()
  }

  private func pick(_ path: String) {
    model.setup.choose(path)
    withAnimation { model.setup.step = .read }
  }
}

/// The mark and the name, where a title bar would put them.
struct Brand: View {
  var body: some View {
    HStack(spacing: 8) {
      LogoMark(size: 15)
      Text("Wind Tunnel").font(Theme.sans(13, .medium)).foregroundStyle(Theme.dim)
    }
  }
}

// MARK: - Pick the app

private struct PickApp: View {
  @Environment(AppModel.self) private var model
  let dropping: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Brand().padding(.top, 46)
      Spacer(minLength: 32)
      Text("Which app should\nwe try to break?")
        .font(Theme.display).tracking(Theme.displayTracking)
        .foregroundStyle(Theme.text)
        .fixedSize(horizontal: false, vertical: true)
        .rise()
      Text("Choose its folder, or drop it on this window. We read the code and point at the handlers that could go wrong when requests overlap. Nothing runs yet.")
        .font(Theme.sans(15)).foregroundStyle(Theme.dim).lineSpacing(5)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 440, alignment: .leading)
        .padding(.top, 20)
        .rise(0.05)
      HStack(spacing: 18) {
        Button(action: choose) {
          HStack(spacing: 8) {
            Text("Choose Folder…")
            KeyHint("⌘O")
          }
        }
        .buttonStyle(ActionButtonStyle(prominent: true, large: true))
        .keyboardShortcut("o", modifiers: .command)
        HStack(spacing: 7) {
          Image(systemName: dropping ? "arrow.down.circle.fill" : "arrow.down.to.line")
            .font(.system(size: 11, weight: .semibold))
            .contentTransition(.symbolEffect(.replace))
          Text(dropping ? "Let go to read it" : "or drop it here")
        }
        .font(Theme.sans(13))
        .foregroundStyle(dropping ? Theme.text : Theme.faint)
      }
      .padding(.top, 32)
      .rise(0.1)
      if !model.recents.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          Text("Recent").label(Theme.ghost).padding(.bottom, 8)
          ForEach(model.recents.prefix(3), id: \.self) { path in
            RecentRow(path: path) {
              model.setup.choose(path)
              withAnimation { model.setup.step = .read }
            }
          }
        }
        .frame(width: 420, alignment: .leading)
        .padding(.top, 52)
        .rise(0.15)
      }
      Spacer(minLength: 32)
      MacStatus().padding(.bottom, 30)
    }
    .padding(.leading, Theme.startMargin)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }

  private func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.prompt = "Choose"
    panel.message = "Choose your app's folder."
    if panel.runModal() == .OK, let url = panel.url {
      model.setup.choose(url.path)
      withAnimation { model.setup.step = .read }
    }
  }
}

/// How the Mac stands, in a line: quiet when it's ready, a button when something's missing.
private struct MacStatus: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let setup = model.setup
    HStack(spacing: 8) {
      if setup.toolchainProblem != nil {
        Circle().fill(Theme.fail).frame(width: 6, height: 6)
        Text(setup.toolchainProblem?.localizedDescription ?? "").foregroundStyle(Theme.dim).lineLimit(1)
        review("How to Fix")
      } else if setup.report == nil {
        DitherBar(width: 22, height: 4)
        Text("Checking this Mac").foregroundStyle(Theme.faint)
      } else if let report = setup.report, !report.steps.isEmpty {
        Circle().fill(Theme.flaky).frame(width: 6, height: 6)
        Text(report.steps.count == 1 ? "One thing to set up on this Mac" : "\(report.steps.count) things to set up on this Mac")
          .foregroundStyle(Theme.dim)
        review("Review")
      } else {
        Image(systemName: "checkmark").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.accent)
        Text("This Mac is ready").foregroundStyle(Theme.faint)
        review("Details")
      }
    }
    .font(Theme.sans(12))
    .animation(Theme.spring, value: setup.report)
  }

  private func review(_ title: String) -> some View {
    Button(title) { model.setup.showMac = true }
      .buttonStyle(LinkButtonStyle(color: Theme.text.opacity(0.85)))
      .padding(.leading, 4)
  }
}

// MARK: - Read the app

/// The app's handlers as the scan read them, the ones worth a look first; beside them, in a column
/// of its own, what to do next.
private struct ReadApp: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let setup = model.setup
    HStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Button {
            withAnimation { setup.step = .app }
          } label: {
            Label("Another app", systemImage: "chevron.left")
          }
          .buttonStyle(LinkButtonStyle())
          if let folder = setup.folder {
            Text(folder.name)
              .font(Theme.title).tracking(Theme.titleTracking).foregroundStyle(Theme.text)
              .padding(.top, 26)
              .rise()
            Text(facts(folder))
              .font(Theme.sans(13)).foregroundStyle(Theme.faint)
              .padding(.top, 6)
              .help(Fmt.tilde(folder.app))
              .rise(0.03)
            Findings(folder: folder).padding(.top, 40)
          }
        }
        .padding(.leading, Theme.startMargin)
        .padding(.trailing, 56)
        .padding(.top, 64)
        .padding(.bottom, 56)
        .frame(maxWidth: 820, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .scrollIndicators(.never)
      if let folder = setup.folder {
        Hairline(vertical: true)
        NextSteps(folder: folder).frame(width: 340)
      }
    }
    .onAppear { setup.watch() }
  }

  private func facts(_ folder: AppFolder) -> String {
    [folder.next.map { "Next.js \($0)" }, folder.packageManager, folder.database].compactMap { $0 }.joined(separator: "  ·  ")
  }
}

/// What the scan found: how many handlers could go wrong, then each of them with the steps it
/// takes and what in them could go wrong, then the rest. Shown top to bottom behind a scan line.
private struct Findings: View {
  @Environment(AppModel.self) private var model
  let folder: AppFolder

  var body: some View {
    let setup = model.setup
    VStack(alignment: .leading, spacing: 0) {
      if !folder.supported {
        Unsupported(folder: folder)
      } else if let scan = setup.scan {
        let risky = scan.routes.filter { !$0.risks.isEmpty }.sorted { $0.risks.count > $1.risks.count }
        let quiet = scan.routes.filter { $0.risks.isEmpty }
        VStack(alignment: .leading, spacing: 0) {
          HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text("\(risky.count)").font(Theme.figure(52)).foregroundStyle(Theme.text)
            Text(risky.isEmpty
              ? "of \(Fmt.plural(scan.routes.count, "handler")) stand out"
              : "of \(Fmt.plural(scan.routes.count, "handler")) could leave your data wrong when requests overlap")
              .font(Theme.sans(15)).foregroundStyle(Theme.dim)
              .fixedSize(horizontal: false, vertical: true)
          }
          HandlerMap(routes: risky + quiet).padding(.top, 14)
          Text(risky.isEmpty
            ? "Read from the code, nothing run. Experiments go after what code can't show: timing."
            : "Read from the code, nothing run. Hints for where to aim: the experiments are what prove it.")
            .font(Theme.sans(12)).foregroundStyle(Theme.faint)
            .padding(.top, 14)
          VStack(alignment: .leading, spacing: 0) {
            ForEach(risky) { route in
              RouteFinding(route: route)
            }
            ForEach(scan.helpers, id: \.flag) { helper in
              Hairline()
              Sentence(text: helper.says).padding(.vertical, 18)
            }
          }
          .padding(.top, 32)
          if !quiet.isEmpty {
            Hairline()
            VStack(alignment: .leading, spacing: 8) {
              Text("Also read").label(Theme.ghost)
              FlowLayout(spacing: 18, lineSpacing: 6) {
                ForEach(quiet) { route in
                  HStack(spacing: 6) {
                    Text(route.method).foregroundStyle(Theme.ghost)
                    Text(route.path.isEmpty ? route.file : route.path).foregroundStyle(Theme.faint)
                  }
                  .font(Theme.mono(11))
                  .help(route.comment ?? route.file)
                }
              }
            }
            .padding(.top, 20)
          }
        }
        .modifier(ScanReveal())
      } else if let error = setup.scanError {
        Text(error).font(Theme.sans(13)).foregroundStyle(Theme.fail.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
        Button("Try Again") { setup.read() }.buttonStyle(ActionButtonStyle()).padding(.top, 14)
      } else {
        HStack(spacing: 12) {
          DitherBar(width: 48, height: 6)
          Text("Reading the code").font(Theme.sans(13)).foregroundStyle(Theme.faint)
        }
        .padding(.top, 8)
      }
    }
  }
}

/// One cell per handler, the ones that could go wrong first, in amber; the rest faint.
private struct HandlerMap: View {
  let routes: [ScanReport.Route]

  var body: some View {
    HStack(spacing: 3) {
      ForEach(routes) { route in
        RoundedRectangle(cornerRadius: 1)
          .fill(route.risks.isEmpty ? Theme.overlay(0.1) : Theme.flaky.opacity(0.85))
          .frame(width: 8, height: 18)
          .help("\(route.method) \(route.path.isEmpty ? route.file : route.path)" + (route.risks.isEmpty ? "" : ": \(Fmt.plural(route.risks.count, "thing")) to look at"))
      }
    }
  }
}

/// Shows its content top to bottom behind a sweeping band of light, once, as if scanned.
private struct ScanReveal: ViewModifier {
  @State private var progress: CGFloat = 0
  @State private var done = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    content
      .mask(alignment: .top) {
        GeometryReader { geo in
          Rectangle().frame(height: geo.size.height * progress)
        }
      }
      .overlay(alignment: .top) {
        GeometryReader { geo in
          if !done {
            ScanBand()
              .frame(width: geo.size.width + 24, height: 40)
              .offset(x: -12, y: geo.size.height * progress - 40)
              .transition(.opacity)
          }
        }
      }
      .onAppear {
        guard !reduceMotion else {
          progress = 1
          done = true
          return
        }
        withAnimation(.easeInOut(duration: 1.2)) { progress = 1 }
        Task {
          try? await Task.sleep(for: .seconds(1.2))
          withAnimation(.easeOut(duration: 0.35)) { done = true }
        }
      }
  }
}

/// One handler: its method and path, the comment over it, the steps it takes (the tables that could
/// go wrong lit), what could go wrong, and what guards it.
private struct RouteFinding: View {
  let route: ScanReport.Route
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Hairline()
      HStack(alignment: .firstTextBaseline, spacing: 0) {
        Text(route.method).font(Theme.mono(11, .medium)).foregroundStyle(Theme.faint).frame(width: 52, alignment: .leading)
        ScrambleText(text: route.path.isEmpty ? "server action" : route.path, font: Theme.mono(13, .medium), color: Theme.text, duration: 0.7)
        Spacer(minLength: 16)
        Text(route.file).font(Theme.mono(11)).foregroundStyle(Theme.ghost).lineLimit(1).truncationMode(.head)
      }
      .padding(.top, 20)
      VStack(alignment: .leading, spacing: 0) {
        if let comment = route.comment {
          Text(comment).font(Theme.sans(13)).foregroundStyle(Theme.faint).padding(.top, 5)
            .fixedSize(horizontal: false, vertical: true)
        }
        let steps = Self.steps(route.does)
        if !steps.isEmpty {
          Text(Self.chain(steps, lit: Self.tables(route)))
            .font(Theme.mono(11)).lineSpacing(5)
            .lineLimit(open ? nil : 2).truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 10)
            .contentShape(Rectangle())
            .onTapGesture { withAnimation(Theme.snappy) { open.toggle() } }
            .help(route.does)
        }
        VStack(alignment: .leading, spacing: 9) {
          ForEach(route.risks, id: \.flag) { risk in
            Sentence(text: risk.says).help(risk.flag)
          }
          ForEach(route.guards, id: \.self) { guardText in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Image(systemName: "checkmark").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.accent).frame(width: 10)
              Text(guardText.prefix(1).uppercased() + guardText.dropFirst()).font(Theme.sans(13)).foregroundStyle(Theme.faint)
            }
          }
        }
        .padding(.top, 14)
      }
      .padding(.leading, 52)
    }
    .padding(.bottom, 22)
  }

  /// The tables the risks name: `payments` in "Adds a row to `payments` …".
  static func tables(_ route: ScanReport.Route) -> Set<String> {
    Set(route.risks.flatMap { risk in
      risk.says.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
    })
  }

  /// The handler's steps from the scan's `does`, in order: the SQL each runs (verb and table),
  /// where its transaction opens and closes, and calls out to other services. The rest (clauses,
  /// helper names) is in the tooltip.
  static func steps(_ does: String) -> [String] {
    let ns = does as NSString
    var out: [String] = []
    var braces: [Bool] = []
    for m in stepPattern.matches(in: does, range: NSRange(location: 0, length: ns.length)) {
      let s = ns.substring(with: m.range)
      if s == "tx{" {
        braces.append(true)
        out.append("tx{")
      } else if s == "{" {
        braces.append(false)
      } else if s == "}" {
        if braces.popLast() == true { out.append("}") }
      } else if m.range(at: 1).location != NSNotFound {
        out.append("\(ns.substring(with: m.range(at: 1))) \(ns.substring(with: m.range(at: 2)))")
      } else if m.range(at: 3).location != NSNotFound {
        out.append("call \(ns.substring(with: m.range(at: 3)))")
      }
    }
    return out
  }

  private static let stepPattern = try! NSRegularExpression(
    pattern: #"tx\{|\{|\}|(?<!DO )\b(SELECT|INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?([A-Za-z_][\w.+]*)|(\w+)→fet"#)

  /// `tx{ INSERT payments · UPDATE orders }`: verbs quiet, tables brighter, the ones at risk in amber.
  static func chain(_ steps: [String], lit: Set<String>) -> AttributedString {
    var out = AttributedString()
    func add(_ text: String, _ color: Color) {
      var a = AttributedString(text)
      a.foregroundColor = color
      out += a
    }
    for (i, step) in steps.enumerated() {
      let previous = i > 0 ? steps[i - 1] : nil
      if step == "}" {
        add(" }", Theme.ghost)
        continue
      }
      if let previous, previous != "tx{" { add("  ·  ", Theme.ghost) }
      if step == "tx{" {
        add("tx{ ", Theme.ghost)
        continue
      }
      let parts = step.split(separator: " ", maxSplits: 1).map(String.init)
      add(parts[0] + " ", Theme.faint)
      let table = parts.count > 1 ? parts[1] : ""
      add(table, table.split(separator: "+").contains { lit.contains(String($0)) } ? Theme.flaky : Theme.dim)
    }
    return out
  }
}

/// A sentence from the scan, names from the code in mono.
private struct Sentence: View {
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Rectangle().fill(Theme.flaky.opacity(0.8)).frame(width: 10, height: 1.5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
      Text(Self.styled(text)).font(Theme.sans(13)).foregroundStyle(Theme.text.opacity(0.88)).lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  static func styled(_ text: String) -> AttributedString {
    var out = AttributedString()
    for (i, part) in text.split(separator: "`", omittingEmptySubsequences: false).enumerated() {
      var a = AttributedString(String(part))
      if i % 2 == 1 {
        a.font = Theme.mono(12)
        a.foregroundColor = Theme.text
      }
      out += a
    }
    return out
  }
}

/// A folder the tool can't run: why, plainly.
private struct Unsupported: View {
  let folder: AppFolder

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(folder.next == nil ? "This doesn't look like a Next.js app." : "This app isn't in a git repository.")
        .font(Theme.sans(17, .semibold)).foregroundStyle(Theme.text)
      Text(folder.next == nil
        ? "Wind Tunnel runs Next.js apps with a Postgres database for now. Choose the folder with the app's package.json, or the repository it's in."
        : "It makes isolated copies of the code with git worktrees. Run git init in the app's folder and commit once, then choose it again.")
        .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 520, alignment: .leading)
    }
  }
}

/// The right column: open the app if it's set up; else an agent to set it up, the folder watched
/// for the file it writes. The Mac's state at the foot.
private struct NextSteps: View {
  @Environment(AppModel.self) private var model
  let folder: AppFolder

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if folder.config != nil {
        ready
      } else if folder.supported {
        setUp
      } else {
        Text("Nothing to set up").font(Theme.sans(17, .semibold)).foregroundStyle(Theme.text)
        Text("Choose the folder of a Next.js app in a git repository.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
          .fixedSize(horizontal: false, vertical: true).padding(.top, 6)
        Button("Choose Another App") { withAnimation { model.setup.step = .app } }
          .buttonStyle(ActionButtonStyle(large: true, wide: true))
          .padding(.top, 24)
      }
      Spacer(minLength: 24)
      MacStatus()
    }
    .padding(.horizontal, 32)
    .padding(.top, 116)
    .padding(.bottom, 30)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Theme.overlay(0.018))
  }

  private var ready: some View {
    VStack(alignment: .leading, spacing: 0) {
      Label("Set up", systemImage: "checkmark").labelStyle(.titleAndIcon).label(Theme.accent)
      Text("Ready to open").font(Theme.sans(17, .semibold)).foregroundStyle(Theme.text).padding(.top, 10)
      Text(folder.experiments > 0
        ? "\(Fmt.plural(folder.experiments, "experiment")) and \(Fmt.plural(folder.flows, "flow")) are written. Open it to run them, or send an agent to find more."
        : "Its config is there, with no experiments yet. Open it and send an agent to write some.")
        .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 6)
      openButton.padding(.top, 24)
      let names = experimentNames
      if !names.isEmpty {
        VStack(alignment: .leading, spacing: 7) {
          Text("Experiments").label(Theme.ghost).padding(.bottom, 3)
          ForEach(names.prefix(9), id: \.self) { name in
            Text(name).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle)
          }
          if names.count > 9 {
            Text("and \(names.count - 9) more").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
          }
        }
        .padding(.top, 36)
      }
    }
    .rise()
  }

  /// The experiments in the app's folder, by file name.
  private var experimentNames: [String] {
    let dir = ((folder.app as NSString).appendingPathComponent(".windtunnel") as NSString).appendingPathComponent("experiments")
    return ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? [])
      .filter { $0.hasSuffix(".yaml") || $0.hasSuffix(".yml") }
      .map { ($0 as NSString).deletingPathExtension }
      .sorted()
  }

  private var setUp: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Next").label(Theme.ghost)
      Text("Set it up with your agent").font(Theme.sans(17, .semibold)).foregroundStyle(Theme.text).padding(.top, 10)
      (Text("It writes ") + Text("windtunnel.config.yaml").font(Theme.mono(12)) + Text(": how to start the app, its database and seed, and two test users. It asks before it writes."))
        .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
        .padding(.top, 6)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(agents, id: \.host) { agent in
          Hairline()
          AgentRow(agent: agent, folder: folder)
        }
        Hairline()
      }
      .padding(.top, 20)
      Watcher(folder: folder).padding(.top, 18)
      openButton.padding(.top, 18)
    }
    .rise()
  }

  private var openButton: some View {
    Button {
      model.finishSetup(open: folder)
    } label: {
      HStack(spacing: 8) {
        Text("Open \(folder.name)")
        KeyHint("↩")
      }
    }
    .buttonStyle(ActionButtonStyle(prominent: true, large: true, wide: true))
    .keyboardShortcut(.defaultAction)
    .disabled(folder.config == nil)
  }

  /// The agents found first; the report decides, else the two most likely.
  private var agents: [InstallReport.Agent] {
    let found = model.setup.report?.agents ?? [
      .init(host: "claude", name: "Claude Code", found: true, plugin: true),
      .init(host: "codex", name: "Codex", found: true, plugin: true),
    ]
    return found.filter(\.found)
  }
}

private struct AgentRow: View {
  @Environment(AppModel.self) private var model
  let agent: InstallReport.Agent
  let folder: AppFolder

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(agent.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
        Text(prompt).font(Theme.mono(11)).foregroundStyle(Theme.faint)
      }
      Spacer(minLength: 8)
      if !agent.plugin {
        Button("Add Plugin…") { model.setup.showMac = true }
          .buttonStyle(LinkButtonStyle(color: Theme.flaky))
          .help("The plugin brings the init skill. Set Up adds it.")
      } else {
        Button(agent.host == "claude" ? "Open" : "Open in Terminal") { open() }
          .buttonStyle(ActionButtonStyle())
          .help(agent.host == "claude" ? "Opens your Claude Code in this folder with \(prompt) typed, not sent." : "Opens \(agent.host) in Terminal in this folder, with \(prompt) on the clipboard to paste.")
      }
    }
    .frame(height: 54)
  }

  private var prompt: String { agent.host == "muse" ? "windtunnel-init" : "/windtunnel:init" }

  private func open() {
    if agent.host == "claude" {
      model.openInClaudeCode(prompt, in: folder.app)
    } else {
      model.openInTerminal(agent.host, prompt: prompt, in: folder.app)
      model.notice = "Opened \(agent.name) in Terminal. \(prompt) is on the clipboard: paste it and press Enter."
    }
  }
}

/// Watching the folder for the config the agent writes.
private struct Watcher: View {
  let folder: AppFolder

  var body: some View {
    let found = folder.config != nil
    HStack(alignment: .center, spacing: 10) {
      Group {
        if found {
          Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.accent)
        } else {
          DitherBar(width: 20, height: 4)
        }
      }
      .frame(width: 20, alignment: .leading)
      (Text(found ? "Found " : "Waiting for ") + Text("windtunnel.config.yaml").font(Theme.mono(11)) + Text(found && folder.flows > 0 ? ", \(Fmt.plural(folder.flows, "flow"))" : ""))
        .font(Theme.sans(12)).foregroundStyle(found ? Theme.text : Theme.faint)
        .lineLimit(1)
    }
    .animation(Theme.spring, value: folder.config)
  }
}

// MARK: - The Mac

/// Everything the Mac needs, checked by the CLI's install, with Set Up to do what's missing.
private struct MacSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let setup = model.setup
    VStack(alignment: .leading, spacing: 0) {
      Text("This Mac").font(Theme.sans(22, .semibold)).foregroundStyle(Theme.text)
      Text("Your app, its database and a browser run here; your coding agent needs the plugin.")
        .font(Theme.sans(13)).foregroundStyle(Theme.dim).padding(.top, 6).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(rows.filter { $0.group == nil }) { row in CheckRow(row: row) }
        Text("Coding agents").label(Theme.ghost).padding(.leading, 28).padding(.top, 14).padding(.bottom, 4)
        ForEach(rows.filter { $0.group != nil }) { row in CheckRow(row: row) }
      }
      .padding(.top, 22)
      if let problem = setup.toolchainProblem {
        ToolchainFix(problem: problem).padding(.top, 20)
      } else if let report = setup.report, !report.steps.isEmpty {
        ToDo(report: report).padding(.top, 22)
      }
      if let error = setup.checkError {
        Text(error).font(Theme.sans(12)).foregroundStyle(Theme.fail).padding(.top, 12)
      }
      HStack(spacing: 10) {
        Button("Check Again") { setup.check() }
          .buttonStyle(ActionButtonStyle())
          .disabled(setup.checking || setup.installing)
        if setup.checking { BrailleSpinner(size: 11) }
        Spacer()
        Button("Done") { dismiss() }
          .buttonStyle(ActionButtonStyle(prominent: true))
          .keyboardShortcut(.defaultAction)
      }
      .padding(.top, 26)
    }
    .padding(28)
    .frame(width: 520)
    .background(Theme.ink)
  }

  /// The checks, in the order they matter: the toolchain, then the services, then the agents.
  private var rows: [CheckRow.Model] {
    let setup = model.setup
    let report = setup.report
    let pending = report == nil && setup.toolchainProblem == nil
    func state(_ name: String, step: String? = nil) -> CheckRow.State {
      if pending { return .checking }
      guard let check = report?.check(name) else { return .unknown }
      if check.ok { return .ok }
      if let step, report?.steps.contains(where: { $0.title.contains(step) }) == true { return .todo }
      return .bad
    }
    var out: [CheckRow.Model] = []
    let node = report?.check("node")
    if case .noNode = setup.toolchainProblem {
      out.append(.init(id: "node", name: "Node.js", detail: "22.18 or newer isn't installed", state: .bad))
    } else {
      out.append(.init(id: "node", name: "Node.js", detail: node.map { $0.detail.replacingOccurrences(of: " (need 22.18+)", with: "") } ?? "", state: state("node")))
    }
    out.append(.init(id: "git", name: "git", detail: report?.check("git")?.detail.replacingOccurrences(of: "git version ", with: "") ?? "", state: state("git")))
    if case .noCLI = setup.toolchainProblem {
      out.append(.init(id: "cli", name: "Command line", detail: "windtunnel isn't installed", state: .bad))
    } else {
      out.append(.init(id: "cli", name: "Command line", detail: setup.toolchain?.describe ?? "", state: setup.toolchain != nil ? .ok : pending ? .checking : .unknown))
    }
    let pg = report?.check("postgres")
    out.append(.init(id: "pg", name: "Postgres", detail: pg.map { $0.ok ? $0.detail.replacingOccurrences(of: "listening on ", with: "") : stepFor("Postgres") != nil ? "will start in Docker, port 55432" : "not running" } ?? "", state: state("postgres", step: "Postgres")))
    let docker = report?.check("docker")
    out.append(.init(id: "docker", name: "Docker", detail: docker.map { $0.ok ? $0.detail : "only needed to start Postgres" } ?? "", state: docker?.ok == false && pg?.ok == true ? .optional : state("docker")))
    out.append(.init(id: "chromium", name: "Chromium", detail: report?.check("chromium").map { $0.ok ? "Playwright's, installed" : "will download, about 150 MB" } ?? "", state: state("chromium", step: "Chromium")))
    for agent in report?.agents ?? [] {
      out.append(.init(
        id: agent.host, name: agent.name, detail: !agent.found ? "not installed" : agent.plugin ? "plugin added" : "will add the plugin",
        state: !agent.found ? .optional : agent.plugin ? .ok : .todo, group: "Coding agents"))
    }
    if pending {
      for name in ["Claude Code", "Codex", "Muse Code"] { out.append(.init(id: name, name: name, detail: "", state: .checking, group: "Coding agents")) }
    }
    return out
  }

  private func stepFor(_ word: String) -> InstallReport.Step? {
    model.setup.report?.steps.first { $0.title.contains(word) }
  }
}

private struct CheckRow: View {
  enum State { case checking, ok, todo, bad, optional, unknown }

  struct Model: Identifiable {
    let id: String
    let name: String
    let detail: String
    let state: State
    var group: String? = nil
  }

  let row: Model

  var body: some View {
    HStack(spacing: 12) {
      ZStack {
        switch row.state {
        case .checking: BrailleSpinner(color: Theme.faint, size: 10)
        case .ok: Image(systemName: "checkmark").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(Theme.accent)
        case .todo: Circle().strokeBorder(Theme.dim, lineWidth: 1.2).frame(width: 9, height: 9)
        case .bad: Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.fail)
        case .optional, .unknown: Text("–").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
        }
      }
      .frame(width: 16)
      Text(row.name)
        .font(Theme.sans(13, .medium))
        .foregroundStyle(row.state == .optional ? Theme.faint : Theme.text)
        .frame(width: 128, alignment: .leading)
      Text(row.detail)
        .font(Theme.sans(12))
        .foregroundStyle(row.state == .bad ? Theme.fail.opacity(0.9) : Theme.faint)
        .lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 0)
    }
    .frame(height: 27)
  }
}

/// What `windtunnel install` would do, and a button to do it, with its output as it goes.
private struct ToDo: View {
  @Environment(AppModel.self) private var model
  let report: InstallReport
  @State private var showCommands = false

  var body: some View {
    let setup = model.setup
    VStack(alignment: .leading, spacing: 14) {
      Hairline()
      VStack(alignment: .leading, spacing: 4) {
        Text(report.steps.count == 1 ? "One thing to set up" : "\(report.steps.count) things to set up")
          .font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
        Text(summary).font(Theme.sans(12)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
      }
      if setup.installing || !setup.installOutput.isEmpty {
        ScrollViewReader { proxy in
          ScrollView {
            VStack(alignment: .leading, spacing: 2) {
              ForEach(Array(setup.installOutput.enumerated()), id: \.offset) { i, line in
                Text(line).font(Theme.mono(11)).foregroundStyle(line.contains("failed") ? Theme.fail : Theme.dim).id(i)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
          }
          .frame(height: 130)
          .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
          .onChange(of: setup.installOutput.count) { proxy.scrollTo(setup.installOutput.count - 1, anchor: .bottom) }
        }
      } else if showCommands {
        Text(setup.commands).font(Theme.mono(11)).foregroundStyle(Theme.dim).lineSpacing(3).textSelection(.enabled)
          .well(padding: 12)
      }
      HStack(spacing: 14) {
        Button {
          setup.install()
        } label: {
          HStack(spacing: 7) {
            if setup.installing { BrailleSpinner(color: Theme.text, size: 10) }
            Text(setup.installing ? "Setting Up…" : "Set Up")
          }
        }
        .buttonStyle(ActionButtonStyle())
        .disabled(setup.installing || setup.checking)
        .help("Runs windtunnel install --yes")
        if !setup.installing {
          Button(showCommands ? "Hide Commands" : "Show Commands") { withAnimation(Theme.snappy) { showCommands.toggle() } }
            .buttonStyle(LinkButtonStyle())
          Button("Copy") { model.copy(setup.commands) }
            .buttonStyle(LinkButtonStyle())
        }
        if setup.installFailed {
          Text("Some steps failed: see above.").font(Theme.sans(12)).foregroundStyle(Theme.fail)
        }
      }
    }
    .rise()
  }

  /// The steps in a sentence: "The plugin for Claude Code and Codex, and Chromium."
  private var summary: String {
    var parts: [String] = []
    let agents = report.steps.compactMap { s in ["Claude Code", "Codex", "Muse Code"].first { s.title.hasPrefix($0) } }
    if !agents.isEmpty { parts.append("the plugin for " + ListFormatter.localizedString(byJoining: agents)) }
    if report.steps.contains(where: { $0.title.contains("Postgres") }) { parts.append("Postgres 17 in Docker") }
    if report.steps.contains(where: { $0.title.contains("Chromium") }) { parts.append("Playwright's Chromium (150 MB)") }
    if report.steps.contains(where: { $0.title.contains("CLI") }) { parts.append("the command line tool") }
    guard !parts.isEmpty else { return "" }
    let text = ListFormatter.localizedString(byJoining: parts) + ". Nothing changes until you click Set Up."
    return text.prefix(1).uppercased() + text.dropFirst()
  }
}

/// No Node or no CLI: what to install, with the command, then Check Again.
private struct ToolchainFix: View {
  @Environment(AppModel.self) private var model
  let problem: Toolchain.Problem

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Hairline()
      switch problem {
      case .noNode:
        Text("Install Node 22.18 or newer, then check again.").font(Theme.sans(13)).foregroundStyle(Theme.text)
        ShellCommand(text: "brew install node")
        Text("Or from nodejs.org, or with nvm: nvm install 24").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      case .noCLI:
        Text("Install the command line tool, then check again. It also adds the plugin to your coding agents.").font(Theme.sans(13)).foregroundStyle(Theme.text)
          .fixedSize(horizontal: false, vertical: true)
        ShellCommand(text: "npx windtunnel-cli install")
        Button("Choose the windtunnel Command…") { chooseCLI() }
          .buttonStyle(LinkButtonStyle())
      }
    }
    .rise()
  }

  private func chooseCLI() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.message = "Choose the windtunnel command, or its bin.js."
    if panel.runModal() == .OK, let url = panel.url {
      model.cliPath = url.path
      model.setup.check()
    }
  }
}

/// A shell command in a well, with a button that copies it.
private struct ShellCommand: View {
  @Environment(AppModel.self) private var model
  let text: String
  @State private var copied = false

  var body: some View {
    HStack(spacing: 10) {
      Text("$").font(Theme.mono(12)).foregroundStyle(Theme.ghost)
      Text(text).font(Theme.mono(12)).foregroundStyle(Theme.text).textSelection(.enabled)
      Spacer()
      Button(copied ? "Copied" : "Copy") {
        model.copy(text)
        copied = true
      }
      .buttonStyle(.plain).font(Theme.sans(11, .medium)).foregroundStyle(copied ? Theme.accent : Theme.faint)
    }
    .padding(.horizontal, 12)
    .frame(height: 34)
    .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
  }
}

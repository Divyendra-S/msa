import SwiftUI
import UniformTypeIdentifiers

/// First run, in two screens. Pick the app; then see what its code shows, read by `windtunnel scan`
/// with nothing set up yet, beside what to do next. The Mac is checked quietly meanwhile and only
/// speaks up when something is missing. A soft light sits in a corner.
struct SetupView: View {
  @Environment(AppModel.self) private var model
  @State private var dropping = false

  var body: some View {
    @Bindable var setup = model.setup
    ZStack {
      Glow(corner: setup.step == .app ? .bottomTrailing : .topTrailing, strength: setup.step == .app ? (dropping ? 0.95 : 0.6) : 0.32)
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.8), value: dropping)
        .animation(.easeInOut(duration: 0.8), value: setup.step)
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
    .animation(.easeInOut(duration: 0.3), value: setup.step)
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

/// The name in the corner, where a title bar would put it.
private struct Brand: View {
  var body: some View {
    HStack(spacing: 8) {
      LogoMark(size: 15)
      Text("Wind Tunnel").font(Theme.sans(12.5, .medium)).foregroundStyle(Theme.faint)
    }
  }
}

// MARK: - Pick the app

private struct PickApp: View {
  @Environment(AppModel.self) private var model
  let dropping: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Brand().padding(.top, 52)
      Spacer(minLength: 40)
      Text("Which app should\nwe try to break?")
        .font(.system(size: 46, weight: .semibold)).tracking(-1.3).lineSpacing(-2)
        .foregroundStyle(Theme.text)
        .fixedSize(horizontal: false, vertical: true)
        .rise()
      Text("Choose its folder, or drop it anywhere here. It reads the code first and shows which handlers could leave your data wrong when requests overlap: two clicks, two tabs, a lost response, a webhook twice. Nothing runs yet, and no model is used.")
        .font(Theme.sans(15)).foregroundStyle(Theme.dim).lineSpacing(4)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 520, alignment: .leading)
        .padding(.top, 18)
        .rise(0.05)
      HStack(spacing: 14) {
        Button("Choose Folder…", action: choose)
          .buttonStyle(ActionButtonStyle(prominent: true))
          .keyboardShortcut("o", modifiers: .command)
        Text(dropping ? "Let go to read it" : "or drop it on this window")
          .font(Theme.sans(12.5)).foregroundStyle(dropping ? Theme.text : Theme.faint)
          .contentTransition(.opacity)
      }
      .padding(.top, 30)
      .rise(0.1)
      if !model.recents.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          Text("Opened before").label(Theme.ghost).padding(.bottom, 4)
          ForEach(model.recents.prefix(4), id: \.self) { path in
            RecentPick(path: path)
          }
        }
        .frame(width: 420, alignment: .leading)
        .padding(.top, 44)
        .rise(0.15)
      }
      Spacer(minLength: 40)
      MacStatus().padding(.bottom, 34)
    }
    .padding(.leading, 88)
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

private struct RecentPick: View {
  @Environment(AppModel.self) private var model
  let path: String
  @State private var hovering = false

  var body: some View {
    Button {
      model.setup.choose(path)
      withAnimation { model.setup.step = .read }
    } label: {
      HStack(spacing: 10) {
        Text((path as NSString).lastPathComponent).font(Theme.sans(13)).foregroundStyle(hovering ? Theme.text : Theme.text.opacity(0.85))
        Text(Fmt.tilde((path as NSString).deletingLastPathComponent)).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1)
        Spacer()
      }
      .padding(.horizontal, 8)
      .frame(height: 30)
      .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.horizontal, -8)
    .onHover { hovering = $0 }
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
        Text(setup.toolchainProblem?.localizedDescription ?? "").font(Theme.sans(12)).foregroundStyle(Theme.dim).lineLimit(1)
        review("How to Fix")
      } else if setup.report == nil {
        BrailleSpinner(color: Theme.faint, size: 10)
        Text("Checking this Mac").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      } else if let report = setup.report, !report.steps.isEmpty {
        Circle().fill(Theme.flaky).frame(width: 6, height: 6)
        Text(report.steps.count == 1 ? "One thing to set up on this Mac" : "\(report.steps.count) things to set up on this Mac")
          .font(Theme.sans(12)).foregroundStyle(Theme.dim)
        review("Review")
      } else {
        Image(systemName: "checkmark").font(.system(size: 9.5, weight: .semibold)).foregroundStyle(Theme.accent)
        Text("This Mac is ready").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        review("Details")
      }
    }
    .animation(Theme.spring, value: setup.report)
  }

  private func review(_ title: String) -> some View {
    Button(title) { model.setup.showMac = true }
      .buttonStyle(.plain).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text.opacity(0.85))
      .padding(.leading, 4)
  }
}

// MARK: - Read the app

/// The app's handlers as the scan read them, the ones worth a look first, beside what to do next.
private struct ReadApp: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let setup = model.setup
    HStack(alignment: .top, spacing: 64) {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Button {
            withAnimation { setup.step = .app }
          } label: {
            HStack(spacing: 5) {
              Image(systemName: "chevron.left").font(.system(size: 9.5, weight: .semibold))
              Text("Another app")
            }
          }
          .buttonStyle(.plain).font(Theme.sans(12)).foregroundStyle(Theme.faint)
          .padding(.bottom, 30)
          if let folder = setup.folder {
            Text(folder.name).font(.system(size: 36, weight: .semibold)).tracking(-0.9).foregroundStyle(Theme.text)
            Text(facts(folder)).font(Theme.sans(13)).foregroundStyle(Theme.faint).padding(.top, 6)
              .help(Fmt.tilde(folder.app))
            Findings(folder: folder).padding(.top, 36)
          }
        }
        .padding(.top, 72)
        .padding(.bottom, 56)
        .frame(maxWidth: 640, alignment: .leading)
      }
      .scrollIndicators(.never)
      if let folder = setup.folder {
        NextSteps(folder: folder)
          .frame(width: 300)
          .padding(.top, 150)
      }
    }
    .padding(.horizontal, 72)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .onAppear { setup.watch() }
  }

  private func facts(_ folder: AppFolder) -> String {
    var parts = [folder.next.map { "Next.js \($0)" }, folder.packageManager, folder.database].compactMap { $0 }
    if let scan = model.setup.scan { parts.append("\(Fmt.plural(scan.routes.count, "handler")), \(Fmt.plural(scan.pages, "page"))") }
    return parts.joined(separator: "  ·  ")
  }
}

/// What the scan found: the handlers worth a look, each pattern in a sentence, then the rest.
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
        Text(risky.isEmpty
          ? "Nothing in the handlers stands out. Experiments go after what code can't show: timing."
          : "\(risky.count == 1 ? "One handler" : "\(risky.count) handlers") could leave your data wrong when requests overlap.")
          .font(Theme.sans(17, .medium)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
          .rise()
        Text("Read from the code in a moment, before anything runs. Hints, not findings: the experiments are what show it.")
          .font(Theme.sans(12.5)).foregroundStyle(Theme.faint).padding(.top, 6)
          .rise(0.03)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(risky.enumerated()), id: \.element.id) { i, route in
            RouteFinding(route: route).rise(0.06 + 0.05 * Double(i))
          }
          ForEach(scan.helpers, id: \.flag) { helper in
            Hairline()
            Sentence(text: helper.says).padding(.vertical, 16)
          }
        }
        .padding(.top, 24)
        if !quiet.isEmpty {
          Hairline()
          VStack(alignment: .leading, spacing: 6) {
            Text("Also read").label(Theme.ghost)
            Text(quiet.map { "\($0.method) \($0.path.isEmpty ? $0.file : $0.path)" }.joined(separator: "   "))
              .font(Theme.mono(11.5)).foregroundStyle(Theme.faint).lineSpacing(4)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.top, 18)
        }
      } else if let error = setup.scanError {
        Text(error).font(Theme.sans(13)).foregroundStyle(Theme.fail.opacity(0.9)).fixedSize(horizontal: false, vertical: true)
        Button("Try Again") { setup.read() }.buttonStyle(ActionButtonStyle()).padding(.top, 14)
      } else {
        HStack(spacing: 10) {
          BrailleSpinner(color: Theme.faint, size: 11)
          Text("Reading the code").font(Theme.sans(14)).foregroundStyle(Theme.faint)
        }
      }
    }
  }
}

/// One handler: its method and path, the comment over it, what could go wrong, and its steps on
/// request.
private struct RouteFinding: View {
  let route: ScanReport.Route
  @State private var open = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Hairline()
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(route.method).font(Theme.mono(11, .medium)).foregroundStyle(Theme.faint)
        Text(route.path.isEmpty ? "server action" : route.path).font(Theme.mono(14, .medium)).foregroundStyle(Theme.text)
        Spacer(minLength: 12)
        Button {
          withAnimation(Theme.snappy) { open.toggle() }
        } label: {
          Text(route.file).font(Theme.mono(11)).foregroundStyle(open ? Theme.dim : Theme.ghost).lineLimit(1).truncationMode(.head)
        }
        .buttonStyle(.plain)
        .help("What it does, in order")
      }
      .padding(.top, 18)
      if let comment = route.comment {
        Text(comment).font(Theme.sans(12.5)).foregroundStyle(Theme.faint).padding(.top, 4)
      }
      VStack(alignment: .leading, spacing: 8) {
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
      .padding(.top, 12)
      if open {
        Text(route.does).font(Theme.mono(11)).foregroundStyle(Theme.dim).lineSpacing(3).textSelection(.enabled)
          .well(padding: 12)
          .padding(.top, 12)
          .transition(.opacity)
      }
    }
    .padding(.bottom, 18)
  }
}

/// A sentence from the scan, names from the code in mono.
private struct Sentence: View {
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Rectangle().fill(Theme.accent.opacity(0.7)).frame(width: 10, height: 1.5).alignmentGuide(.firstTextBaseline) { $0[.bottom] + 4 }
      Text(Self.styled(text)).font(Theme.sans(13.5)).foregroundStyle(Theme.text.opacity(0.88)).lineSpacing(3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  static func styled(_ text: String) -> AttributedString {
    var out = AttributedString()
    for (i, part) in text.split(separator: "`", omittingEmptySubsequences: false).enumerated() {
      var a = AttributedString(String(part))
      if i % 2 == 1 {
        a.font = Theme.mono(12.5)
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
        .font(Theme.sans(17, .medium)).foregroundStyle(Theme.text)
      Text(folder.next == nil
        ? "Wind Tunnel runs Next.js apps with a Postgres database for now. Choose the folder with the app's package.json, or the repository it's in."
        : "It makes isolated copies of the code with git worktrees. Run git init in the app's folder and commit once, then choose it again.")
        .font(Theme.sans(13.5)).foregroundStyle(Theme.dim).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// The right column: open the app if it's set up; else an agent to set it up, the folder watched
/// for the file it writes.
private struct NextSteps: View {
  @Environment(AppModel.self) private var model
  let folder: AppFolder

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if folder.config != nil {
        Text("Set up already").label(Theme.ghost)
        Text(folder.experiments > 0 ? "\(Fmt.plural(folder.experiments, "experiment")) written, \(Fmt.plural(folder.flows, "flow"))." : "Its config is there; no experiments yet.")
          .font(Theme.sans(14)).foregroundStyle(Theme.text).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
        Button("Open \(folder.name)") { model.finishSetup(open: folder) }
          .buttonStyle(ActionButtonStyle(prominent: true))
          .keyboardShortcut(.defaultAction)
          .padding(.top, 18)
      } else if folder.supported {
        Text("Next").label(Theme.ghost)
        Text("Your coding agent sets it up: it writes windtunnel.config.yaml (how to start the app, its database and seed, two test users) and asks before it does.")
          .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).padding(.top, 8).fixedSize(horizontal: false, vertical: true)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(agents, id: \.host) { agent in
            AgentRow(agent: agent, folder: folder)
          }
        }
        .padding(.top, 14)
        Watcher(folder: folder).padding(.top, 16)
        Button("Open \(folder.name)") { model.finishSetup(open: folder) }
          .buttonStyle(ActionButtonStyle(prominent: true))
          .keyboardShortcut(.defaultAction)
          .disabled(folder.config == nil)
          .padding(.top, 18)
      }
      MacStatus().padding(.top, 36)
    }
  }

  /// The agents found first; the report decides, else all three.
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
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(agent.name).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text)
        Text(prompt).font(Theme.mono(11)).foregroundStyle(Theme.faint)
      }
      Spacer(minLength: 8)
      if !agent.plugin {
        Button("Add Plugin…") { model.setup.showMac = true }
          .buttonStyle(.plain).font(Theme.sans(12)).foregroundStyle(Theme.flaky)
          .help("The plugin brings the init skill. Set Up adds it.")
      } else {
        Button(agent.host == "claude" ? "Open" : "Open in Terminal") { open() }
          .buttonStyle(ActionButtonStyle())
          .help(agent.host == "claude" ? "Opens your Claude Code in this folder with \(prompt) typed, not sent." : "Opens \(agent.host) in Terminal in this folder, with \(prompt) on the clipboard to paste.")
      }
    }
    .frame(height: 46)
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
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Group {
        if folder.config != nil {
          Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.accent)
        } else {
          BrailleSpinner(color: Theme.faint, size: 10)
        }
      }
      .frame(width: 12)
      Text(folder.config != nil
        ? "windtunnel.config.yaml is there" + (folder.flows > 0 ? ", with \(Fmt.plural(folder.flows, "flow"))" : "") + ". Open the app when your agent is done."
        : "Waiting for windtunnel.config.yaml")
        .font(Theme.sans(12.5)).foregroundStyle(folder.config != nil ? Theme.text : Theme.faint)
        .fixedSize(horizontal: false, vertical: true)
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
      Text("This Mac").font(Theme.sans(20, .semibold)).foregroundStyle(Theme.text)
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
        .font(Theme.sans(12.5))
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
        Text(summary).font(Theme.sans(12.5)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
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
            .buttonStyle(.plain).font(Theme.sans(12)).foregroundStyle(Theme.faint)
          Button("Copy") { model.copy(setup.commands) }
            .buttonStyle(.plain).font(Theme.sans(12)).foregroundStyle(Theme.faint)
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
          .buttonStyle(.plain).font(Theme.sans(12)).foregroundStyle(Theme.faint)
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
      .buttonStyle(.plain).font(Theme.sans(11.5, .medium)).foregroundStyle(copied ? Theme.accent : Theme.faint)
    }
    .padding(.horizontal, 12)
    .frame(height: 34)
    .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
  }
}

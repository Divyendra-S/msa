import SwiftUI

/// Where a hunt runs. All three use the same hunt skill.
enum HuntHost: String, CaseIterable {
  /// Your own Claude Code, on your login: opened with the prompt typed, not sent.
  case claudeCode
  /// Claude 5 headless, on an Anthropic API key, never your login.
  case claudeAPI
  /// Muse Code headless, on the Meta key in the bridge's shell.
  case muse

  var title: String {
    switch self {
    case .claudeCode: "Claude Code"
    case .claudeAPI: "Claude API"
    case .muse: "Muse"
    }
  }
}

/// Send an agent to break the app, and follow what it runs.
struct HuntView: View {
  @Environment(AppModel.self) private var model
  @State private var area = ""
  @State private var host: HuntHost = .claudeCode
  @State private var model5 = "claude-opus-5-5"
  @State private var budget = 5.0
  @State private var showKey = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        HStack(alignment: .top, spacing: 40) {
          composer
          RecentTrace()
        }
        .rise()
        if let hunt = current {
          HuntSession(hunt: hunt).id(hunt.id)
        }
        ActivityPanel().rise(0.06)
        if !model.hunts.isEmpty { PastHunts().rise(0.1) }
      }
      .padding(.horizontal, Theme.gutter)
      .padding(.top, 4)
      .padding(.bottom, 32)
      .frame(maxWidth: Theme.measure, alignment: .leading)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.automatic)
    .sheet(isPresented: $showKey) { KeySheet().environment(model) }
  }

  private var prompt: String {
    let a = area.trimmingCharacters(in: .whitespacesAndNewlines)
    return "/windtunnel:hunt" + (a.isEmpty ? "" : " \(a)")
  }

  private var current: HuntInfo? {
    if let id = model.selectedHunt, let h = model.hunts.first(where: { $0.id == id }) { return h }
    return model.runningHunt
  }

  private var composer: some View {
    ZStack(alignment: .topLeading) {
      VStack(alignment: .leading, spacing: 0) {
        Text("Send an agent to break your app")
          .font(Theme.sans(22, .semibold)).tracking(-0.4).foregroundStyle(Theme.text)
        Text("It finds the risky spots, writes experiments, and keeps the ones that break a rule.")
          .font(Theme.sans(13)).foregroundStyle(Theme.dim)
          .padding(.top, 6)
        HStack(spacing: 10) {
          Image(systemName: "scope").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.faint)
          TextField("", text: $area, prompt: Text("The whole app, or an area like checkout").foregroundStyle(Theme.faint))
            .textFieldStyle(.plain)
            .font(Theme.sans(15))
            .foregroundStyle(Theme.text)
            .onSubmit(start)
          Text(prompt).font(Theme.mono(11)).foregroundStyle(Theme.ghost).lineLimit(1)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .frame(maxWidth: 600)
        .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .padding(.top, 22)
        HStack(spacing: 16) {
          TabStrip(items: HuntHost.allCases, selection: $host, size: 12) { h, _ in
            Text(h.title).opacity(available(h) ? 1 : 0.55)
          }
          if host == .claudeAPI, available(.claudeAPI) {
            Picker("", selection: $model5) {
              ForEach(models, id: \.self) { m in
                Text(m.replacingOccurrences(of: "claude-", with: "").replacingOccurrences(of: "-5-5", with: " 5.5").capitalized).tag(m)
              }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .controlSize(.small)
            .fixedSize()
            Stepper(value: $budget, in: 0.5...50, step: 0.5) {
              Text("Cap \(Fmt.usd(budget))").font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.dim)
            }
            .controlSize(.small)
            .help("The most this hunt may spend")
          }
        }
        .padding(.top, 14)
        HStack(spacing: 14) {
          Text(note).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1).help(host == .claudeCode ? "It runs on your own plan when you press Return." : note)
          Spacer(minLength: 0)
          action
        }
        .frame(maxWidth: 600)
        .padding(.top, 10)
      }
      .padding(.vertical, 8)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var models: [String] {
    model.status?.hunt.hosts?["claude"]?.models ?? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
  }

  private func available(_ h: HuntHost) -> Bool {
    switch h {
    case .claudeCode: true
    case .claudeAPI: model.status?.hunt.hosts?["claude"]?.ok ?? false
    case .muse: model.status?.hunt.hosts?["muse"]?.ok ?? model.status?.hunt.ok ?? false
    }
  }

  private var note: String {
    switch host {
    case .claudeCode:
      return "Opens your Claude Code with the hunt typed, not sent."
    case .claudeAPI:
      if available(.claudeAPI) { return "Runs claude --bare on your API key and streams here. Never your Claude login." }
      if !model.hasAnthropicKey { return "Add an Anthropic API key to run hunts in this window." }
      return model.status?.hunt.hosts?["claude"]?.reason ?? "Update the windtunnel CLI to use this."
    case .muse:
      if available(.muse) { return "Muse Code headless, billed to the Meta key in the bridge's shell." }
      return model.status?.hunt.hosts?["muse"]?.reason ?? model.status?.hunt.reason ?? "Start the bridge from the Muse shell."
    }
  }

  @ViewBuilder
  private var action: some View {
    switch host {
    case .claudeCode:
      Button(action: start) {
        Label("Open in Claude Code", systemImage: "arrow.up.forward.app")
      }
      .buttonStyle(ActionButtonStyle(prominent: true))
      .help("Needs the plugin: windtunnel install --hosts claude")
    case .claudeAPI:
      if available(.claudeAPI) {
        HStack(spacing: 8) {
          Button("Key…") { showKey = true }.buttonStyle(ActionButtonStyle())
          Button(action: start) { Label("Start hunt", systemImage: "play.fill") }
            .buttonStyle(ActionButtonStyle(prominent: true))
            .disabled(model.runningHunt != nil)
        }
      } else {
        Button {
          showKey = true
        } label: {
          Label(model.hasAnthropicKey ? "Change key…" : "Add API key…", systemImage: "key")
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
      }
    case .muse:
      Button(action: start) { Label("Start hunt", systemImage: "play.fill") }
        .buttonStyle(ActionButtonStyle(prominent: true))
        .disabled(!available(.muse) || model.runningHunt != nil)
    }
  }

  private func start() {
    switch host {
    case .claudeCode:
      model.openInClaudeCode(prompt)
    case .claudeAPI:
      guard available(.claudeAPI), model.runningHunt == nil else { return }
      model.startHunt(prompt: prompt, host: "claude", model: model5, budget: budget)
    case .muse:
      guard available(.muse), model.runningHunt == nil else { return }
      model.startHunt(prompt: prompt.replacingOccurrences(of: "/windtunnel:hunt", with: "Use the windtunnel-hunt skill to hunt"), host: "muse", model: nil, budget: nil)
    }
  }
}

/// The project's recent runs played back as a trace, whoever started them: a hunt here, your agent
/// in its own terminal, or Run all. Each sends requests at once; red where that broke a rule.
private struct RecentTrace: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let recent = Array(model.runs.filter { $0.outcome != "running" }.prefix(16))
    let failed = recent.map { $0.outcome == "fail" || $0.outcome == "error" }
    let broke = failed.filter { $0 }.count
    VStack(spacing: 14) {
      RequestTrace(trailing: 14, lanes: 6, top: 0.1, bottom: 0.9, speed: 30, runs: failed, busy: model.runningHunt != nil)
        .frame(width: 280, height: 132)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.35)], startPoint: .leading, endPoint: .trailing))
      VStack(spacing: 3) {
        Text(model.runningHunt != nil ? "Hunting" : recent.isEmpty ? "Listening for runs" : "Last \(Fmt.plural(recent.count, "run"))")
          .font(Theme.sans(12, .medium)).foregroundStyle(Theme.dim)
        Text(recent.isEmpty ? "They show up here as they start" : broke == 0 ? "Every rule held" : "\(broke) broke a rule")
          .font(Theme.sans(12)).foregroundStyle(broke > 0 ? Theme.fail : Theme.faint)
      }
    }
    .frame(width: 280)
    .padding(.top, 4)
    .help("Recent runs played back. Each sends requests at once; red where that broke a rule.")
  }
}

/// A hunt started from this window: the agent's messages and tool calls as they stream in.
private struct HuntSession: View {
  @Environment(AppModel.self) private var model
  let hunt: HuntInfo

  var body: some View {
    let events = model.huntEvents[hunt.id] ?? []
    let running = hunt.status == "running"
    VStack(alignment: .leading, spacing: 14) {
      Hairline()
      HStack(spacing: 12) {
        if running { BrailleSpinner(size: 12) } else { Circle().fill(Tone(hunt.status).color).frame(width: 6, height: 6) }
        VStack(alignment: .leading, spacing: 2) {
          Text(hunt.prompt).font(Theme.mono(12, .medium)).foregroundStyle(Theme.text).lineLimit(1)
          Text("\(hunt.host ?? "muse")\(hunt.model.map { " · \($0)" } ?? "") · \(Fmt.clock(ISO.date(hunt.startedAt)))")
            .font(Theme.sans(11)).foregroundStyle(Theme.faint)
        }
        Spacer()
        Metric(label: "Tokens", value: Fmt.kilo(hunt.usage.input + hunt.usage.output))
        Metric(label: "Cost", value: Fmt.usd(hunt.usage.usd))
        if let cap = hunt.budgetUsd {
          Meter(value: hunt.usage.usd / cap, color: hunt.usage.usd / cap > 0.8 ? Theme.fail : Theme.accent)
            .frame(width: 70)
            .help("\(Fmt.usd(hunt.usage.usd)) of a \(Fmt.usd(cap)) cap")
        }
        if running {
          Button("Stop") { model.stopHunt(hunt.id) }.buttonStyle(ActionButtonStyle(color: Theme.fail))
        }
      }
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 8) {
            ForEach(events) { e in
              EventLine(event: e).id(e.seq)
            }
            if running {
              HStack(spacing: 6) {
                BrailleSpinner(size: 11)
                Text("Working").font(Theme.sans(12)).foregroundStyle(Theme.faint)
              }
              .id(-1)
            }
          }
          .padding(16)
        }
        .frame(height: 340)
        .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
        .onChange(of: events.count) {
          withAnimation(Theme.snappy) { proxy.scrollTo(running ? -1 : (events.last?.seq ?? 0), anchor: .bottom) }
        }
      }
    }
    .task(id: hunt.id) { await model.loadHunt(hunt.id) }
    .rise()
  }
}

private struct Metric: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 1) {
      Text(value).font(Theme.sans(13, .medium)).monospacedDigit().foregroundStyle(Theme.text).contentTransition(.numericText())
      Text(label).font(Theme.sans(11)).foregroundStyle(Theme.faint)
    }
    .animation(Theme.snappy, value: value)
  }
}

private struct EventLine: View {
  let event: HuntEvent

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(String(format: "%5.1fs", event.at / 1000)).font(Theme.mono(10)).foregroundStyle(Theme.ghost)
      switch event.kind {
      case "tool":
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(event.tool ?? "tool").foregroundStyle(Theme.accent.opacity(0.9))
          if let t = event.text { Text(t).foregroundStyle(Theme.faint).lineLimit(2) }
        }
        .font(Theme.mono(11))
      case "message":
        Text(event.text ?? "").font(Theme.sans(13)).foregroundStyle(Theme.text).lineSpacing(2).textSelection(.enabled)
      case "stderr":
        Text(event.text ?? "").font(Theme.mono(11)).foregroundStyle(Theme.fail.opacity(0.8)).lineLimit(3)
      case "end":
        Text(event.text ?? "Ended").font(Theme.sans(12, .medium)).foregroundStyle(Theme.dim)
      case "usage":
        Text("\(Fmt.kilo(event.usage?.input ?? 0)) in · \(Fmt.kilo(event.usage?.output ?? 0)) out").font(Theme.sans(11)).foregroundStyle(Theme.ghost)
      default:
        Text(event.text ?? event.type ?? event.kind).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .transition(.opacity.combined(with: .offset(y: 4)))
  }
}

/// What's happening in the project, whoever is doing it: runs your agent starts in its own
/// session (Claude Code, Codex) show up here as they start and finish.
private struct ActivityPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Panel("Activity", accessory: {
      HStack(spacing: 4) {
        LiveDot(on: model.live)
        Text(model.live ? "Live" : "Offline")
      }
    }) {
      if model.activity.isEmpty {
        Text("Runs your agent starts appear here as they happen.").font(Theme.sans(13)).foregroundStyle(Theme.dim)
        .help("When your agent calls windtunnel_run, here or in its own terminal, each run shows up as it starts.")
      } else {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(model.activity.prefix(12)) { a in
            ActivityRow(activity: a)
              .transition(.move(edge: .top).combined(with: .opacity))
          }
        }
        .padding(.horizontal, -10)
        .animation(Theme.spring, value: model.activity.first?.id)
      }
    }
  }
}

private struct ActivityRow: View {
  @Environment(AppModel.self) private var model
  let activity: Activity
  @State private var hovering = false

  var body: some View {
    let a = activity
    HStack(spacing: 11) {
      Group {
        if a.kind == .started { BrailleSpinner(size: 10) } else { Circle().fill(color).frame(width: 6, height: 6) }
      }
      .frame(width: 12)
      Text(text).font(Theme.sans(13)).foregroundStyle(Theme.text.opacity(0.88)).lineLimit(1)
      Spacer()
      Text(Fmt.clock(a.at)).font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.ghost)
    }
    .padding(.horizontal, 10)
    .frame(height: 32)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering && a.run != nil ? Theme.hover : .clear))
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
    .onTapGesture {
      guard let run = a.run else { return }
      model.selectedRun = run
      model.section = .runs
    }
  }

  private var color: Color {
    switch activity.kind {
    case .finished: Tone(activity.outcome).color
    case .hunt: Theme.accent
    default: Theme.faint
    }
  }

  private var text: String {
    switch activity.kind {
    case .started: "\(activity.text) started"
    case .finished: "\(activity.text) \(activity.outcome == "pass" ? "passed" : activity.outcome == "fail" ? "failed" : (activity.outcome ?? "ended"))"
    default: activity.text
    }
  }
}

private struct PastHunts: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Panel("Past hunts", accessory: { Text("\(model.hunts.count)") }) {
      VStack(spacing: 0) {
        ForEach(model.hunts.prefix(12)) { h in
          HStack(spacing: 12) {
            Group {
              if h.status == "running" { BrailleSpinner(size: 10) } else { Circle().fill(Tone(h.status).color).frame(width: 6, height: 6) }
            }
            .frame(width: 10)
            Text(h.prompt).font(Theme.mono(12)).foregroundStyle(Theme.text.opacity(0.88)).lineLimit(1)
            Text(h.host ?? "muse").font(Theme.sans(12)).foregroundStyle(Theme.faint)
            Spacer()
            Text(Fmt.usd(h.usage.usd)).font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.dim)
            Text(Fmt.ago(ISO.date(h.startedAt))).font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.ghost)
          }
          .padding(.horizontal, 10)
          .frame(height: 32)
          .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(model.selectedHunt == h.id ? Theme.selection : .clear))
          .contentShape(Rectangle())
          .onTapGesture { withAnimation(Theme.spring) { model.selectedHunt = h.id } }
        }
      }
      .padding(.horizontal, -10)
    }
  }
}

/// Asks for the Anthropic API key and keeps it in the keychain.
struct KeySheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var key = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text("Anthropic API key").font(Theme.sans(15, .semibold)).foregroundStyle(Theme.text)
        Text("For hunts in this window. Kept in your keychain and given only to the bridge; the hunt runs claude --bare, which never reads your Claude login.")
          .font(Theme.sans(12)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
      }
      SecureField("", text: $key, prompt: Text("sk-ant-…").foregroundStyle(Theme.ghost))
        .textFieldStyle(.plain)
        .font(Theme.mono(13))
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(Theme.well))
        .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
      Text("Your own Claude plan needs no key: pick Claude Code.").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      HStack {
        if model.hasAnthropicKey {
          Button("Remove Key") {
            model.saveAnthropicKey(nil)
            dismiss()
          }
          .buttonStyle(ActionButtonStyle(color: Theme.fail))
        }
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(ActionButtonStyle()).keyboardShortcut(.cancelAction)
        Button("Save") {
          model.saveAnthropicKey(key)
          dismiss()
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
        .keyboardShortcut(.defaultAction)
        .disabled(!key.hasPrefix("sk-"))
      }
    }
    .padding(24)
    .frame(width: 480)
    .background(Backdrop())
  }
}

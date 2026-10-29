import SwiftUI

/// Send an agent to break the app. Three ways to run it, all with the same hunt skill:
/// your own Claude Code (your login, interactive), Claude 5 headless (an Anthropic API key,
/// never your login), or Muse Code (the Meta key).
struct HuntView: View {
  @Environment(AppModel.self) private var model
  @State private var area = ""
  @State private var model5 = "claude-opus-5-5"
  @State private var budget = 5.0
  @State private var showKey = false

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        hero
        input
        HStack(alignment: .top, spacing: 14) {
          ClaudeCodeCard(prompt: prompt)
          ClaudeKeyCard(prompt: prompt, model5: $model5, budget: $budget, showKey: $showKey)
          MuseCard(prompt: prompt)
        }
        .rise(0.08)
        if let hunt = current {
          HuntSession(hunt: hunt).id(hunt.id)
        }
        FollowPanel()
        if !model.hunts.isEmpty { PastHunts() }
      }
      .padding(24)
      .frame(maxWidth: 1240, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.automatic)
    .background(DotGrid().ignoresSafeArea())
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

  private var hero: some View {
    ZStack(alignment: .leading) {
      AirflowField(fontSize: 10, color: Theme.accent, center: CGPoint(x: 0.78, y: 0.52), radius: 0.22, lines: 10, speed: model.runningHunt != nil ? 1.8 : 1)
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0.25), .init(color: .black, location: 0.62)], startPoint: .leading, endPoint: .trailing))
      VStack(alignment: .leading, spacing: 10) {
        Text("hunt").label(Theme.accent)
        ScrambleText(text: "Send an agent to break your app", font: Theme.mono(24, .bold), duration: 0.8)
        Text("It reads the app map, writes experiments for the risky spots (double submits, late webhooks,\ntwo tabs, slow payments), runs them, and keeps the ones that break a rule.")
          .font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3)
      }
      .padding(24)
    }
    .frame(height: 190)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface.opacity(0.6)))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.lineStrong))
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .rise()
  }

  private var input: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("where to hunt").label()
      HStack(spacing: 0) {
        Text("❯ ").font(Theme.mono(15, .bold)).foregroundStyle(Theme.accent)
        Text("/windtunnel:hunt ").font(Theme.mono(15)).foregroundStyle(Theme.faint)
        TextField("", text: $area, prompt: Text("checkout").foregroundStyle(Theme.ghost))
          .textFieldStyle(.plain)
          .font(Theme.mono(15))
          .foregroundStyle(Theme.text)
        if area.isEmpty { BlinkCursor().padding(.trailing, 6) }
      }
      .padding(.horizontal, 14)
      .frame(height: 46)
      .background(RoundedRectangle(cornerRadius: 8).fill(Theme.bg))
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.accent.opacity(0.35)))
      .shadow(color: Theme.accent.opacity(0.08), radius: 16)
      Text("An area of the app (a page, a flow, a feature), or empty for the whole app.").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
    }
    .rise(0.04)
  }
}

private struct HostCard<Content: View>: View {
  let title: String
  let subtitle: String
  let color: Color
  let available: Bool
  @ViewBuilder var content: () -> Content
  @State private var hovering = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Circle().fill(available ? color : Theme.ghost).frame(width: 7, height: 7)
        Text(title).font(Theme.mono(12, .semibold)).foregroundStyle(Theme.text)
      }
      Text(subtitle).label(available ? color.opacity(0.85) : Theme.faint)
      content()
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 236, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(hovering ? Theme.raised : Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(hovering && available ? color.opacity(0.45) : Theme.line))
    .offset(y: hovering ? -2 : 0)
    .shadow(color: hovering && available ? color.opacity(0.12) : .clear, radius: 18, y: 6)
    .onHover { hovering = $0 }
    .animation(Theme.spring, value: hovering)
  }
}

private struct ClaudeCodeCard: View {
  @Environment(AppModel.self) private var model
  let prompt: String

  var body: some View {
    HostCard(title: "Claude Code", subtitle: "your login · interactive", color: Theme.accent, available: true) {
      Text("Opens your own Claude Code in a new terminal, in this app's folder, with the prompt typed but not sent. Press Enter there to start: it runs on your plan, in your session.")
        .font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
      Text("This window follows along: every run it starts shows up below, live.")
        .font(Theme.sans(12)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button {
        model.openInClaudeCode(prompt)
      } label: {
        Label("Hunt in Claude Code", systemImage: "arrow.up.forward.app")
      }
      .buttonStyle(TermButtonStyle(prominent: true))
      Text("needs the plugin: windtunnel install --hosts claude").font(Theme.mono(9.5)).foregroundStyle(Theme.ghost)
    }
  }
}

private struct ClaudeKeyCard: View {
  @Environment(AppModel.self) private var model
  let prompt: String
  @Binding var model5: String
  @Binding var budget: Double
  @Binding var showKey: Bool

  var body: some View {
    let host = model.status?.hunt.hosts?["claude"]
    let ok = host?.ok ?? false
    let models = host?.models ?? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    HostCard(title: "Claude 5 · headless", subtitle: "api key · streams here", color: Theme.pass, available: ok) {
      Text("Runs claude -p --bare from the bridge and streams every step here. Billed to your API key; --bare never reads your Claude login.")
        .font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 4) {
        ForEach(models, id: \.self) { m in
          let name = m.replacingOccurrences(of: "claude-", with: "").replacingOccurrences(of: "-5-5", with: " 5.5")
          Button {
            withAnimation(Theme.snappy) { model5 = m }
          } label: {
            Text(name)
              .font(Theme.mono(10.5, model5 == m ? .semibold : .regular))
              .foregroundStyle(model5 == m ? Theme.bg : Theme.dim)
              .padding(.horizontal, 8).padding(.vertical, 4)
              .background(RoundedRectangle(cornerRadius: 5).fill(model5 == m ? Theme.pass : Theme.raised))
          }
          .buttonStyle(.plain)
        }
      }
      HStack(spacing: 8) {
        Text("cap").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
        Stepper(value: $budget, in: 0.5...50, step: 0.5) {
          Text(Fmt.usd(budget)).font(Theme.mono(11.5)).foregroundStyle(Theme.text).frame(width: 52, alignment: .leading)
        }
        .controlSize(.small)
      }
      Spacer(minLength: 0)
      if ok {
        Button {
          model.startHunt(prompt: prompt, host: "claude", model: model5, budget: budget)
        } label: {
          Label("Start hunt", systemImage: "play.fill")
        }
        .buttonStyle(TermButtonStyle(prominent: true, color: Theme.pass))
        .disabled(model.runningHunt != nil)
      } else {
        Text(!model.hasAnthropicKey ? "No API key yet. Without one, use Claude Code on your own login." : (host?.reason ?? "Update the windtunnel CLI to use this.")).font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(4).fixedSize(horizontal: false, vertical: true)
        Button {
          showKey = true
        } label: {
          Label(model.hasAnthropicKey ? "Change key…" : "Add API key…", systemImage: "key")
        }
        .buttonStyle(TermButtonStyle())
      }
    }
  }
}

private struct MuseCard: View {
  @Environment(AppModel.self) private var model
  let prompt: String

  var body: some View {
    let host = model.status?.hunt.hosts?["muse"]
    let ok = host?.ok ?? model.status?.hunt.ok ?? false
    HostCard(title: "Muse Code", subtitle: "meta key · streams here", color: Theme.flaky, available: ok) {
      Text("Muse Code headless (muse exec --json) on Muse Wonder, billed to the Meta key in the shell that started the bridge.")
        .font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if ok {
        Button {
          model.startHunt(prompt: prompt.replacingOccurrences(of: "/windtunnel:hunt", with: "Use the windtunnel-hunt skill to hunt"), host: "muse", model: nil, budget: nil)
        } label: {
          Label("Start hunt", systemImage: "play.fill")
        }
        .buttonStyle(TermButtonStyle(prominent: true, color: Theme.flaky))
        .disabled(model.runningHunt != nil)
      } else {
        Text(host?.reason ?? model.status?.hunt.reason ?? "").font(Theme.mono(10)).foregroundStyle(Theme.faint).lineLimit(5).fixedSize(horizontal: false, vertical: true)
      }
    }
  }
}

/// A hunt started from this window: the agent's messages and tool calls as they stream in.
private struct HuntSession: View {
  @Environment(AppModel.self) private var model
  let hunt: HuntInfo

  var body: some View {
    let events = model.huntEvents[hunt.id] ?? []
    let running = hunt.status == "running"
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        if running { BrailleSpinner(size: 13) } else { Text(Tone(hunt.status).glyph).font(Theme.mono(13, .bold)).foregroundStyle(Tone(hunt.status).color) }
        VStack(alignment: .leading, spacing: 2) {
          Text(hunt.prompt).font(Theme.mono(12.5, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
          Text("\(hunt.host ?? "muse")\(hunt.model.map { " · \($0)" } ?? "") · started \(Fmt.clock(ISO.date(hunt.startedAt)))")
            .font(Theme.mono(10)).foregroundStyle(Theme.faint)
        }
        Spacer()
        Metric(label: "in", value: Fmt.kilo(hunt.usage.input))
        Metric(label: "out", value: Fmt.kilo(hunt.usage.output))
        Metric(label: "cost", value: Fmt.usd(hunt.usage.usd))
        if let cap = hunt.budgetUsd {
          AsciiBar(value: hunt.usage.usd / cap, width: 10, color: hunt.usage.usd / cap > 0.8 ? Theme.fail : Theme.pass, font: Theme.mono(9))
        }
        if running {
          Button("Stop") { model.stopHunt(hunt.id) }.buttonStyle(TermButtonStyle(color: Theme.fail))
        }
      }
      .padding(14)
      Rectangle().fill(Theme.line).frame(height: 1)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 6) {
            ForEach(events) { e in
              EventLine(event: e).id(e.seq)
            }
            if running {
              HStack(spacing: 6) {
                BrailleSpinner(size: 11)
                Text("working").font(Theme.mono(11)).foregroundStyle(Theme.faint)
              }
              .id(-1)
            }
          }
          .padding(14)
        }
        .frame(height: 360)
        .onChange(of: events.count) {
          withAnimation(Theme.snappy) { proxy.scrollTo(running ? -1 : (events.last?.seq ?? 0), anchor: .bottom) }
        }
      }
    }
    .background(RoundedRectangle(cornerRadius: 9).fill(Theme.bg))
    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(running ? Theme.accent.opacity(0.4) : Theme.lineStrong))
    .task(id: hunt.id) { await model.loadHunt(hunt.id) }
    .rise()
  }
}

private struct Metric: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 1) {
      Text(value).font(Theme.mono(12, .semibold)).foregroundStyle(Theme.text).contentTransition(.numericText())
      Text(label).label()
    }
    .animation(Theme.snappy, value: value)
  }
}

private struct EventLine: View {
  let event: HuntEvent

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Text(String(format: "%5.1fs", event.at / 1000)).font(Theme.mono(10)).foregroundStyle(Theme.ghost)
      switch event.kind {
      case "tool":
        HStack(alignment: .top, spacing: 6) {
          Text("⏵").foregroundStyle(Theme.accent)
          Text(event.tool ?? "tool").foregroundStyle(Theme.accent)
          if let t = event.text { Text(t).foregroundStyle(Theme.faint).lineLimit(2) }
        }
        .font(Theme.mono(11))
      case "message":
        Text(event.text ?? "").font(Theme.sans(12.5)).foregroundStyle(Theme.text).lineSpacing(2).textSelection(.enabled)
      case "stderr":
        Text(event.text ?? "").font(Theme.mono(10.5)).foregroundStyle(Theme.fail.opacity(0.8)).lineLimit(3)
      case "end":
        Text("── \(event.text ?? "ended") ──").font(Theme.mono(10.5)).foregroundStyle(Theme.dim)
      case "usage":
        Text("tokens \(Fmt.kilo(event.usage?.input ?? 0)) in · \(Fmt.kilo(event.usage?.output ?? 0)) out").font(Theme.mono(10)).foregroundStyle(Theme.ghost)
      default:
        Text(event.text ?? event.type ?? event.kind).font(Theme.mono(10.5)).foregroundStyle(Theme.faint).lineLimit(2)
      }
      Spacer(minLength: 0)
    }
    .transition(.opacity.combined(with: .offset(y: 4)))
  }
}

/// What's happening in the project, whoever is doing it: runs your agent starts in its own
/// session (Claude Code, Codex) show up here as they start and finish.
private struct FollowPanel: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Panel("following this project", tint: model.live ? Theme.accent.opacity(0.3) : Theme.lineStrong, titleColor: model.live ? Theme.accent : Theme.dim, accessory: {
      HStack(spacing: 6) {
        LiveDot(on: model.live)
        Text(model.live ? "live" : "offline").font(Theme.mono(10)).foregroundStyle(Theme.faint)
      }
    }) {
      if model.activity.isEmpty {
        HStack(spacing: 10) {
          BrailleSpinner(color: Theme.faint)
          Text("Waiting for runs. When your agent calls windtunnel_run (here or in its own terminal), each run appears as it starts.")
            .font(Theme.mono(11)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
      } else {
        VStack(alignment: .leading, spacing: 5) {
          ForEach(model.activity.prefix(14)) { a in
            HStack(spacing: 10) {
              Text(Fmt.clock(a.at)).font(Theme.mono(10)).foregroundStyle(Theme.ghost)
              Text(glyph(a)).font(Theme.mono(11, .bold)).foregroundStyle(color(a)).frame(width: 14)
              Text(label(a)).font(Theme.mono(11)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
              Spacer()
              if let run = a.run {
                Button("open") {
                  model.selectedRun = run
                  model.section = .runs
                }
                .buttonStyle(.plain)
                .font(Theme.mono(10.5))
                .foregroundStyle(Theme.accent)
              }
            }
            .transition(.move(edge: .top).combined(with: .opacity))
          }
        }
        .animation(Theme.spring, value: model.activity.first?.id)
      }
    }
  }

  private func glyph(_ a: Activity) -> String {
    switch a.kind {
    case .started: "○"
    case .finished: Tone(a.outcome).glyph
    case .job: "▶"
    case .hunt: "◎"
    case .note: "·"
    }
  }

  private func color(_ a: Activity) -> Color {
    a.kind == .started ? Theme.accent : a.kind == .finished ? Tone(a.outcome).color : Theme.dim
  }

  private func label(_ a: Activity) -> String {
    switch a.kind {
    case .started: "started \(a.text)"
    case .finished: "\(a.text) → \(a.outcome ?? "")"
    default: a.text
    }
  }
}

private struct PastHunts: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Panel("hunts", accessory: {
      Text("\(model.hunts.count)").font(Theme.mono(10)).foregroundStyle(Theme.faint)
    }) {
      VStack(spacing: 2) {
        ForEach(model.hunts.prefix(12)) { h in
          HStack(spacing: 10) {
            Text(h.status == "running" ? "○" : Tone(h.status).glyph).foregroundStyle(Tone(h.status).color).frame(width: 14)
            Text(h.prompt).foregroundStyle(Theme.text).lineLimit(1)
            Text(h.host ?? "muse").foregroundStyle(Theme.faint)
            Spacer()
            Text("\(Fmt.kilo(h.usage.input + h.usage.output)) tok").foregroundStyle(Theme.faint)
            Text(Fmt.usd(h.usage.usd)).foregroundStyle(Theme.dim)
            Text(Fmt.ago(ISO.date(h.startedAt))).foregroundStyle(Theme.faint)
          }
          .font(Theme.mono(11))
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
          .background(RoundedRectangle(cornerRadius: 5).fill(model.selectedHunt == h.id ? Theme.raised : .clear))
          .contentShape(Rectangle())
          .onTapGesture { withAnimation(Theme.spring) { model.selectedHunt = h.id } }
        }
      }
    }
  }
}

/// Asks for the Anthropic API key and keeps it in the keychain.
struct KeySheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var key = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("anthropic api key").label(Theme.accent)
      Text("For headless Claude 5 hunts in this window. It stays in your keychain and only reaches the bridge's environment; the hunt runs claude --bare, which uses this key and never your Claude login.")
        .font(Theme.sans(12.5)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
      SecureField("", text: $key, prompt: Text("sk-ant-…").foregroundStyle(Theme.ghost))
        .textFieldStyle(.plain)
        .font(Theme.mono(13))
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.bg))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.lineStrong))
      Text("Your own Claude subscription works without a key: use Hunt in Claude Code.").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
      HStack {
        if model.hasAnthropicKey {
          Button("Remove key") {
            model.saveAnthropicKey(nil)
            dismiss()
          }
          .buttonStyle(TermButtonStyle(color: Theme.fail))
        }
        Spacer()
        Button("Cancel") { dismiss() }.buttonStyle(TermButtonStyle()).keyboardShortcut(.cancelAction)
        Button("Save") {
          model.saveAnthropicKey(key)
          dismiss()
        }
        .buttonStyle(TermButtonStyle(prominent: true))
        .keyboardShortcut(.defaultAction)
        .disabled(!key.hasPrefix("sk-"))
      }
    }
    .padding(22)
    .frame(width: 480)
    .background(Theme.surface)
    .preferredColorScheme(.dark)
  }
}

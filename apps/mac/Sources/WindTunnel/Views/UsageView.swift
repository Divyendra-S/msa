import SwiftUI

/// What Wind Tunnel itself costs: tokens its tools returned into the agent's context, and the
/// small decisions it made (by rules for free, by a small model, or handed to the agent).
struct UsageView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        VStack(alignment: .leading, spacing: 8) {
          Text("usage").label(Theme.accent)
          ScrambleText(text: "What Wind Tunnel costs your agent", font: Theme.mono(22, .bold))
          Text("Every tool result goes into your agent's context, so it is capped and counted. Small decisions go to free rules first.")
            .font(Theme.sans(13)).foregroundStyle(Theme.dim)
        }
        .rise()
        if let usage = model.usage {
          let latest = usage.jobs.first
          HStack(spacing: 14) {
            Panel("latest job · tokens returned") {
              VStack(alignment: .leading, spacing: 8) {
                Text(Fmt.kilo(latest?.tokens ?? 0)).font(Theme.mono(30, .semibold)).foregroundStyle(Theme.text).contentTransition(.numericText())
                AsciiBar(value: (latest?.tokens ?? 0) / max(1, usage.budget.tokens), width: 26, color: Theme.accent)
                Text("budget \(Fmt.kilo(usage.budget.tokens)) per job").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
              }
            }
            Panel("small-model spend") {
              VStack(alignment: .leading, spacing: 8) {
                Text(Fmt.usd(latest?.usd ?? 0)).font(Theme.mono(30, .semibold)).foregroundStyle(Theme.text)
                AsciiBar(value: (latest?.usd ?? 0) / max(0.0001, usage.budget.usd), width: 26, color: Theme.pass)
                Text("budget \(Fmt.usd(usage.budget.usd)) per job").font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
              }
            }
            Panel("hunts from this window") {
              let total = model.hunts.reduce(0) { $0 + $1.usage.usd }
              VStack(alignment: .leading, spacing: 8) {
                Text(Fmt.usd(total)).font(Theme.mono(30, .semibold)).foregroundStyle(Theme.text)
                Text("\(model.hunts.count) hunts · \(Fmt.kilo(model.hunts.reduce(0) { $0 + $1.usage.input + $1.usage.output })) tokens")
                  .font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
                Text("as the agents reported them").font(Theme.mono(10.5)).foregroundStyle(Theme.ghost)
              }
            }
          }
          .rise(0.05)
          Panel("jobs", accessory: { Text("newest first").font(Theme.mono(10)).foregroundStyle(Theme.faint) }) {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 9) {
              GridRow {
                ForEach(["job", "tool calls", "tokens", "largest", "decisions", "", "small model", "last"], id: \.self) { Text($0).label() }
              }
              ForEach(usage.jobs) { job in
                GridRow {
                  Text(job.job).foregroundStyle(Theme.text)
                  Text("\(job.toolCalls)").foregroundStyle(Theme.dim)
                  Text(Fmt.kilo(job.tokens)).foregroundStyle(Theme.text)
                  Text(Fmt.kilo(job.maxTokens ?? 0)).foregroundStyle(Theme.faint)
                  DecisionBar(d: job.decisions)
                  Text(decisionText(job.decisions)).foregroundStyle(Theme.faint)
                  Text(Fmt.usd(job.usd)).foregroundStyle(job.usd > 0 ? Theme.flaky : Theme.faint)
                  Text(Fmt.ago(ISO.date(job.last))).foregroundStyle(Theme.faint)
                }
                .font(Theme.mono(11))
              }
            }
          }
          .rise(0.1)
          HStack(spacing: 16) {
            legend("rules", Theme.pass)
            legend("small model", Theme.flaky)
            legend("jev", Theme.error)
            legend("agent", Theme.accent)
          }
        } else {
          EmptyBlock(text: "No usage recorded yet.")
        }
      }
      .padding(24)
      .frame(maxWidth: 1180, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
    .background(DotGrid().ignoresSafeArea())
  }

  private func decisionText(_ d: UsageTotals.Decisions?) -> String {
    guard let d else { return "" }
    return "\(d.rules ?? 0) / \(d.spark ?? 0) / \(d.jev ?? 0) / \(d.agent ?? 0)"
  }

  private func legend(_ label: String, _ color: Color) -> some View {
    HStack(spacing: 6) {
      RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 10, height: 10)
      Text(label).font(Theme.mono(10.5)).foregroundStyle(Theme.faint)
    }
  }
}

private struct DecisionBar: View {
  let d: UsageTotals.Decisions?

  var body: some View {
    let parts: [(Int, Color)] = [(d?.rules ?? 0, Theme.pass), (d?.spark ?? 0, Theme.flaky), (d?.jev ?? 0, Theme.error), (d?.agent ?? 0, Theme.accent)]
    let total = max(1, parts.reduce(0) { $0 + $1.0 })
    HStack(spacing: 1) {
      ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
        if p.0 > 0 {
          RoundedRectangle(cornerRadius: 1.5).fill(p.1).frame(width: max(3, 120 * CGFloat(p.0) / CGFloat(total)), height: 8)
        }
      }
    }
    .frame(width: 124, alignment: .leading)
  }
}

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var showKey = false

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 18) {
      VStack(alignment: .leading, spacing: 8) {
        Text("claude 5").label(Theme.accent)
        HStack {
          Text(model.hasAnthropicKey ? "API key saved in the keychain" : "No API key: hunts run in your own Claude Code")
            .font(Theme.mono(11.5)).foregroundStyle(Theme.text)
          Spacer()
          Button(model.hasAnthropicKey ? "Change…" : "Add key…") { showKey = true }.buttonStyle(TermButtonStyle())
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Text("windtunnel cli").label(Theme.accent)
        TextField("", text: $model.cliPath, prompt: Text("auto: \(model.toolchainDescription.isEmpty ? "windtunnel on PATH" : model.toolchainDescription)").foregroundStyle(Theme.ghost))
          .textFieldStyle(.plain)
          .font(Theme.mono(11.5))
          .padding(8)
          .background(RoundedRectangle(cornerRadius: 5).fill(Theme.bg))
          .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.lineStrong))
        Text("Path to the CLI's bin.js (or bin.ts in a checkout). Empty: windtunnel on your login shell's PATH, else the checkout this app was built from.")
          .font(Theme.sans(11)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        Spacer()
        Button("Reconnect") { model.reconnect() }.buttonStyle(TermButtonStyle(prominent: true))
      }
    }
    .padding(22)
    .frame(width: 520)
    .background(Theme.surface)
    .preferredColorScheme(.dark)
    .sheet(isPresented: $showKey) { KeySheet().environment(model) }
  }
}

/// The menu bar item: what's running, the newest results, and the main actions.
struct MenuBarView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        LogoMark(size: 16)
        Text("wind tunnel").font(Theme.mono(12, .semibold)).foregroundStyle(Theme.text)
        Spacer()
        LiveDot(on: model.live)
      }
      if let s = model.status {
        Text(s.project.name).font(Theme.mono(11)).foregroundStyle(Theme.accent)
      } else {
        Text("no project open").font(Theme.mono(11)).foregroundStyle(Theme.faint)
      }
      if let hunt = model.runningHunt {
        HStack(spacing: 8) {
          BrailleSpinner()
          Text("hunting \(hunt.prompt)").font(Theme.mono(11)).foregroundStyle(Theme.text).lineLimit(1)
          Spacer()
          Text(Fmt.usd(hunt.usage.usd)).font(Theme.mono(10.5)).foregroundStyle(Theme.dim)
        }
      }
      if let job = model.runningJob {
        HStack(spacing: 8) {
          BrailleSpinner(color: Theme.flaky)
          Text("running \(job.experiments.isEmpty ? "all experiments" : job.experiments.joined(separator: ", "))").font(Theme.mono(11)).foregroundStyle(Theme.text).lineLimit(1)
        }
      }
      if let batch = model.batches.first {
        VStack(alignment: .leading, spacing: 5) {
          Text("latest · \(Fmt.ago(batch.started))").label()
          ForEach(batch.runs.prefix(6)) { run in
            HStack(spacing: 8) {
              Text(Tone(run.outcome).glyph).foregroundStyle(Tone(run.outcome).color)
              Text(run.experiment).foregroundStyle(Theme.text).lineLimit(1)
              Spacer()
            }
            .font(Theme.mono(11))
          }
          if batch.runs.count > 6 { Text("+\(batch.runs.count - 6) more").font(Theme.mono(10)).foregroundStyle(Theme.faint) }
        }
      }
      Rectangle().fill(Theme.line).frame(height: 1)
      HStack(spacing: 8) {
        Button("Open") {
          openWindow(id: "main")
          NSApp.activate()
        }
        .buttonStyle(TermButtonStyle(prominent: true))
        Button("Run all") { model.runExperiments([]) }.buttonStyle(TermButtonStyle()).disabled(model.api == nil || model.runningJob != nil)
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }.buttonStyle(TermButtonStyle())
      }
    }
    .padding(14)
    .frame(width: 320)
    .background(Theme.bg)
    .preferredColorScheme(.dark)
  }
}

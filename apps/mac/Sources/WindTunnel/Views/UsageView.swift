import SwiftUI

/// What Wind Tunnel itself costs: tokens its tools returned into the agent's context, and the
/// small decisions it made (by rules for free, by a small model, or handed to the agent).
struct UsageView: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 36) {
        if let usage = model.usage {
          let latest = usage.jobs.first
          HStack(alignment: .top, spacing: 0) {
            Metric(
              title: "Tokens returned", value: Fmt.kilo(latest?.tokens ?? 0),
              fraction: (latest?.tokens ?? 0) / max(1, usage.budget.tokens),
              caption: "of \(Fmt.kilo(usage.budget.tokens)) per job",
              help: "Every tool result goes into your agent's context, so Wind Tunnel caps and counts it. This is the newest job.")
            Hairline(vertical: true).padding(.horizontal, 28)
            Metric(
              title: "Small-model spend", value: Fmt.usd(latest?.usd ?? 0),
              fraction: (latest?.usd ?? 0) / max(0.0001, usage.budget.usd),
              caption: "of \(Fmt.usd(usage.budget.usd)) per job",
              help: "Small decisions go to free rules first, then to a small model, then to your agent.")
            Hairline(vertical: true).padding(.horizontal, 28)
            Metric(
              title: "Hunts", value: Fmt.usd(model.hunts.reduce(0) { $0 + $1.usage.usd }),
              fraction: nil,
              caption: "\(Fmt.plural(model.hunts.count, "hunt")) · \(Fmt.kilo(model.hunts.reduce(0) { $0 + $1.usage.input + $1.usage.output })) tokens",
              help: "Hunts from this window, as the agents reported them.")
          }
          .fixedSize(horizontal: false, vertical: true)
          .rise()
          Panel("Jobs", accessory: {
            HStack(spacing: 12) {
              legend("Rules", Self.decisionColors[0])
              legend("Small model", Self.decisionColors[1])
              legend("Jev", Self.decisionColors[2])
              legend("Agent", Self.decisionColors[3])
            }
          }) {
            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
              GridRow {
                ForEach(["Job", "Calls", "Tokens", "Largest", "Decisions", "Model", "Last"], id: \.self) { Text($0).label() }
              }
              GridRow { Hairline().gridCellColumns(7) }
              ForEach(usage.jobs) { job in
                GridRow {
                  Text(job.job).font(Theme.mono(12)).foregroundStyle(Theme.text)
                  Text("\(job.toolCalls)").foregroundStyle(Theme.dim)
                  Text(Fmt.kilo(job.tokens)).foregroundStyle(Theme.text)
                  Text(Fmt.kilo(job.maxTokens ?? 0)).foregroundStyle(Theme.faint)
                  DecisionBar(d: job.decisions).help(decisionText(job.decisions))
                  Text(Fmt.usd(job.usd)).foregroundStyle(job.usd > 0 ? Theme.text : Theme.faint)
                  Text(Fmt.ago(ISO.date(job.last))).foregroundStyle(Theme.faint)
                }
                .font(Theme.sans(12.5))
                .monospacedDigit()
              }
            }
          }
          .rise(0.06)
        } else {
          EmptyState(title: "No usage yet", text: "Tokens and decisions show up after your agent's first job.").frame(height: 420)
        }
      }
      .padding(.horizontal, 28)
      .padding(.top, 8)
      .padding(.bottom, 32)
      .frame(maxWidth: 1100, alignment: .leading)
      .frame(maxWidth: .infinity)
    }
  }

  private func decisionText(_ d: UsageTotals.Decisions?) -> String {
    guard let d else { return "" }
    return "\(d.rules ?? 0) by rules, \(d.spark ?? 0) by a small model, \(d.jev ?? 0) by jev, \(d.agent ?? 0) by the agent"
  }

  /// Who decided, cheapest first, in shades of the hue.
  static let decisionColors: [Color] = [Theme.accentLight, Theme.accent, Theme.accentDeep, Color.white.opacity(0.45)]

  private func legend(_ label: String, _ color: Color) -> some View {
    HStack(spacing: 5) {
      RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 8, height: 4)
      Text(label)
    }
  }
}

/// A figure with its title above and, under it, how full its budget is.
private struct Metric: View {
  let title: String
  let value: String
  let fraction: Double?
  let caption: String
  let help: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).font(Theme.sans(12.5)).foregroundStyle(Theme.faint)
      Text(value).font(Theme.figure(36)).foregroundStyle(Theme.text).contentTransition(.numericText()).padding(.top, 6)
      Meter(value: fraction ?? 0).padding(.top, 12).opacity(fraction == nil ? 0 : 1)
      Text(caption).font(Theme.sans(12)).foregroundStyle(Theme.faint).padding(.top, 10)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .help(help)
  }
}

private struct DecisionBar: View {
  let d: UsageTotals.Decisions?

  var body: some View {
    let c = UsageView.decisionColors
    let parts: [(Int, Color)] = [(d?.rules ?? 0, c[0]), (d?.spark ?? 0, c[1]), (d?.jev ?? 0, c[2]), (d?.agent ?? 0, c[3])]
    SplitBar(parts: parts).frame(width: 130)
  }
}

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var showKey = false

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 22) {
      VStack(alignment: .leading, spacing: 8) {
        Text("Claude API key").label()
        HStack {
          Text(model.hasAnthropicKey ? "Saved in the keychain" : "None. Hunts run in your own Claude Code.")
            .font(Theme.sans(13)).foregroundStyle(Theme.text)
          Spacer()
          Button(model.hasAnthropicKey ? "Change…" : "Add Key…") { showKey = true }.buttonStyle(ActionButtonStyle())
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Text("windtunnel CLI").label()
        TextField("", text: $model.cliPath, prompt: Text(model.toolchainDescription.isEmpty ? "windtunnel on PATH" : model.toolchainDescription).foregroundStyle(Theme.ghost))
          .textFieldStyle(.plain)
          .font(Theme.mono(12))
          .padding(.horizontal, 10)
          .frame(height: 32)
          .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(Theme.well))
          .overlay(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        Text("Path to the CLI's bin.js. Empty: windtunnel on your PATH, else this checkout.")
          .font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
      }
      if let info = model.info {
        VStack(alignment: .leading, spacing: 8) {
          Text("Bridge").label()
          Text("127.0.0.1:\(info.port)\(info.reused ? " (shared)" : "")").font(Theme.mono(12)).foregroundStyle(Theme.dim)
        }
      }
      HStack {
        Spacer()
        Button("Reconnect") { model.reconnect() }.buttonStyle(ActionButtonStyle(prominent: true))
      }
    }
    .padding(24)
    .frame(width: 520)
    .background(Backdrop())
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
      HStack(spacing: 9) {
        LogoMark(size: 18)
        VStack(alignment: .leading, spacing: 0) {
          Text("Wind Tunnel").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
          Text(model.status?.project.name ?? "No project open").font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
        }
        Spacer()
        LiveDot(on: model.live)
      }
      if let hunt = model.runningHunt {
        HStack(spacing: 8) {
          BrailleSpinner()
          Text("Hunting \(hunt.prompt)").font(Theme.sans(12)).foregroundStyle(Theme.text).lineLimit(1)
          Spacer()
          Text(Fmt.usd(hunt.usage.usd)).font(Theme.sans(11.5)).monospacedDigit().foregroundStyle(Theme.dim)
        }
      }
      if let job = model.runningJob {
        HStack(spacing: 8) {
          BrailleSpinner()
          Text(job.experiments.isEmpty ? "Running all" : "Running \(job.experiments.joined(separator: ", "))").font(Theme.sans(12)).foregroundStyle(Theme.text).lineLimit(1)
        }
      }
      if let batch = model.batches.first {
        VStack(alignment: .leading, spacing: 6) {
          Text("Latest · \(Fmt.ago(batch.started))").label()
          ForEach(batch.runs.prefix(6)) { run in
            HStack(spacing: 9) {
              Circle().fill(Tone(run.outcome).color).frame(width: 6, height: 6)
              Text(run.experiment).font(Theme.sans(12)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
              Spacer()
            }
          }
          if batch.runs.count > 6 { Text("\(batch.runs.count - 6) more").font(Theme.sans(11)).foregroundStyle(Theme.faint) }
        }
      }
      Hairline()
      HStack(spacing: 8) {
        Button("Open") {
          openWindow(id: "main")
          NSApp.activate()
        }
        .buttonStyle(ActionButtonStyle(prominent: true))
        Button("Run all") { model.runExperiments([]) }.buttonStyle(ActionButtonStyle()).disabled(model.api == nil || model.runningJob != nil)
        Spacer()
        Button("Quit") { NSApp.terminate(nil) }.buttonStyle(ActionButtonStyle())
      }
    }
    .padding(16)
    .frame(width: 320)
    .preferredColorScheme(.dark)
  }
}

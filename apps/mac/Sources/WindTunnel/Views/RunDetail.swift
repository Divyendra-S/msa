import SwiftUI

enum RunTab: String, CaseIterable {
  case summary, timeline, trace, database, network, log
}

struct RunDetailView: View {
  @Environment(AppModel.self) private var model
  let runID: String
  @State private var detail: RunDetail?
  @State private var rep: RepView?
  @State private var comparison: Comparison?
  @State private var selectedRep: Int?
  @State private var tab: RunTab = Launch.value("--tab").flatMap(RunTab.init(rawValue:)) ?? .summary
  @State private var error: String?
  @Namespace private var tabLine

  var body: some View {
    let version = model.runVersions[runID] ?? 0
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        if let detail {
          RunHeader(detail: detail, rep: rep, selectedRep: $selectedRep)
          tabs
          Group {
            switch tab {
            case .summary: SummaryTab(detail: detail, rep: rep, comparison: comparison)
            case .timeline: TimelineTab(rep: rep, comparison: comparison)
            case .trace: TraceTab(rep: rep)
            case .database: DatabaseTab(rep: rep)
            case .network: NetworkTab(rep: rep)
            case .log: LogTab(rep: rep)
            }
          }
          .id(tab)
          .transition(.opacity.combined(with: .offset(y: 4)))
        } else if let error {
          EmptyState(title: "Couldn't open this run", text: error).frame(height: 400)
        } else {
          LoadingBlock()
        }
      }
      .padding(24)
      .frame(maxWidth: 1240, alignment: .leading)
    }
    .scrollIndicators(.automatic)
    .background(Theme.bg)
    .animation(Theme.spring, value: tab)
    .task(id: "\(runID)#\(version)") { await loadRun() }
    .task(id: "\(runID)#\(version)#\(selectedRep ?? -1)") { await loadRep() }
  }

  private var tabs: some View {
    HStack(spacing: 22) {
      ForEach(RunTab.allCases, id: \.self) { t in
        Button {
          withAnimation(Theme.spring) { tab = t }
        } label: {
          VStack(spacing: 6) {
            HStack(spacing: 5) {
              Text(t.rawValue).font(Theme.mono(11.5, tab == t ? .semibold : .regular))
              if let badge = badge(t) { Text(badge).font(Theme.mono(9.5)).foregroundStyle(t == .summary ? Theme.fail : Theme.faint) }
            }
            .foregroundStyle(tab == t ? Theme.text : Theme.dim)
            ZStack {
              if tab == t {
                Rectangle().fill(Theme.accent).frame(height: 2).matchedGeometryEffect(id: "line", in: tabLine)
              } else {
                Rectangle().fill(.clear).frame(height: 2)
              }
            }
          }
          .fixedSize()
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
      Spacer()
    }
    .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
  }

  private func badge(_ t: RunTab) -> String? {
    guard let rep else { return nil }
    switch t {
    case .summary: return rep.rules.filter { !$0.ok }.isEmpty ? nil : "\(rep.rules.filter { !$0.ok }.count)"
    case .trace: return rep.trace.map { "\($0.tables.count)" }
    case .database: return rep.diff.map { "\($0.tables.count)" }
    case .network: return "\(rep.requests.filter(\.notable).count)"
    default: return nil
    }
  }

  private func loadRun() async {
    guard let api = model.api else { return }
    do {
      let d: RunDetail = try await api.get("/api/runs/\(runID)")
      withAnimation(Theme.spring) { detail = d }
      if selectedRep == nil || !(d.reps.contains { $0.rep == selectedRep }) { selectedRep = d.focus ?? d.reps.first?.rep }
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  private func loadRep() async {
    guard let api = model.api, let n = selectedRep, let detail else { return }
    let r: RepView? = try? await api.get("/api/runs/\(runID)/reps/\(n)")
    withAnimation(Theme.spring) { rep = r }
    // Side by side with a run that held every rule: where this one first went another way.
    if let ref = detail.reference, r?.outcome != "ok" {
      let lanes = "\(runID)/\(n),\(ref.run)/\(ref.rep)"
      let c: Comparison? = try? await api.get("/api/compare?lanes=\(lanes)")
      withAnimation(Theme.spring) { comparison = c }
    } else if let r, detail.reps.count > 1 {
      // A passing repetition: line it up with the first one that broke, if any.
      if let bad = detail.reps.first(where: { $0.outcome != "ok" })?.rep, bad != r.rep {
        let c: Comparison? = try? await api.get("/api/compare?lanes=\(runID)/\(bad),\(runID)/\(r.rep)")
        withAnimation(Theme.spring) { comparison = c }
      } else {
        comparison = nil
      }
    } else {
      comparison = nil
    }
  }
}

private struct LoadingBlock: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        BrailleSpinner()
        Text("reading the run").font(Theme.mono(11)).foregroundStyle(Theme.dim)
      }
      ForEach(0..<5, id: \.self) { i in
        RoundedRectangle(cornerRadius: 4).fill(Theme.surface).frame(width: [420, 300, 520, 260, 380][i], height: 14)
          .phaseAnimator([0.4, 1]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.9).delay(Double(i) * 0.08) }
      }
    }
    .padding(.top, 8)
  }
}

// MARK: - Header

struct RunHeader: View {
  @Environment(AppModel.self) private var model
  let detail: RunDetail
  let rep: RepView?
  @Binding var selectedRep: Int?

  var body: some View {
    let outcome = detail.result?.outcome ?? "running"
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Text("run \(detail.id)").label()
        if let label = detail.result?.version?.label { Text("· \(label)").label() }
        if let started = ISO.date(detail.result?.startedAt) { Text("· \(Fmt.day(started)) \(Fmt.clock(started))").label() }
        Spacer()
      }
      HStack(alignment: .firstTextBaseline, spacing: 14) {
        ScrambleText(text: detail.experiment.id, font: Theme.mono(24, .bold), color: Theme.text)
          .textSelection(.enabled)
        OutcomeBadge(outcome: outcome, large: true)
        Spacer()
      }
      if let d = detail.experiment.description {
        Text(d).font(Theme.sans(13.5)).foregroundStyle(Theme.dim).lineSpacing(2).frame(maxWidth: 760, alignment: .leading)
      }
      HStack(spacing: 6) {
        if let ms = detail.result?.durationMs { Chip(text: "⏱ \(Fmt.ms(ms))") }
        if let flow = detail.experiment.flow { Chip(text: "flow \(flow)") }
        Chip(text: Fmt.plural(detail.total, "rep"))
        if let triage = detail.triage {
          Chip(text: "\(triage.label ?? "sorted") · by \(triage.by)", color: triage.label == "bug" ? Theme.fail : Theme.flaky)
        }
        if let ref = detail.reference {
          Chip(text: "vs \(ref.run == detail.id ? "rep \(ref.rep)" : "passing run …\(ref.run.suffix(4))")", color: Theme.accent.opacity(0.8)).help(ref.label)
        }
      }
      if let triage = detail.triage {
        Text(triage.reason).font(Theme.mono(11)).foregroundStyle(Theme.faint)
      }
      HStack(spacing: 14) {
        VStack(alignment: .leading, spacing: 5) {
          Text("repetitions").label()
          RepStrip(
            outcomes: detail.reps.map(\.outcome),
            pending: max(0, detail.total - detail.reps.count),
            selected: selectedRep
          ) { n in withAnimation(Theme.spring) { selectedRep = n } }
        }
        if let variants = detail.result?.variants, !variants.isEmpty {
          VStack(alignment: .leading, spacing: 5) {
            Text("orderings").label()
            HStack(spacing: 10) {
              ForEach(variants, id: \.variant) { v in
                Text("\(v.variant) \(v.ok)/\(v.runs)")
                  .font(Theme.mono(11))
                  .foregroundStyle(Tone(v.outcome).color)
                  .fixedSize()
                  .help("\(v.variant): \(v.ok) of \(v.runs) held every rule")
              }
            }
            .frame(height: 20)
          }
        }
        Spacer()
        Button {
          model.runExperiments([detail.experiment.id])
        } label: {
          Label("Run again", systemImage: "arrow.clockwise")
        }
        .buttonStyle(TermButtonStyle())
        .disabled(model.runningJob != nil)
        if outcome != "pass" {
          Button {
            model.openInClaudeCode(fixPrompt)
          } label: {
            Label("Fix in Claude Code", systemImage: "terminal")
          }
          .buttonStyle(TermButtonStyle(prominent: true))
          .help("Opens Claude Code in this app's folder with the prompt typed, not sent: it runs on your own login when you press Enter")
        }
      }
    }
    .rise()
  }

  private var fixPrompt: String {
    "Wind Tunnel run \(detail.id) (experiment \(detail.experiment.id)) broke a rule. Read its evidence with windtunnel_evidence handle=\(detail.id), find the cause, fix it, then prove the fix with /windtunnel:prove \(detail.experiment.id)."
  }
}

// MARK: - Summary

struct SummaryTab: View {
  let detail: RunDetail
  let rep: RepView?
  let comparison: Comparison?

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if let comparison, let i = comparison.divergence.firstIndex(where: { $0 != nil }), let d = comparison.divergence[i] {
        DivergenceCallout(divergence: d, lane: comparison.lanes[i], reference: comparison.reference >= 0 ? comparison.lanes[comparison.reference] : nil)
      }
      if let rep {
        RulesPanel(rules: rep.rules)
        if let diff = rep.diff, !diff.tables.isEmpty {
          Panel("database changes", accessory: { Text(rep.diffSummary ?? "").font(Theme.mono(9.5)).foregroundStyle(Theme.faint).lineLimit(1) }) {
            FlowLayout(spacing: 6) {
              ForEach(diff.tables.keys.sorted(), id: \.self) { name in
                let t = diff.tables[name]!
                HStack(spacing: 5) {
                  Text(name).foregroundStyle(Theme.text)
                  if !t.added.isEmpty { Text("+\(t.added.count)").foregroundStyle(Theme.pass) }
                  if !t.removed.isEmpty { Text("−\(t.removed.count)").foregroundStyle(Theme.fail) }
                  if !t.changed.isEmpty { Text("~\(t.changed.count)").foregroundStyle(Theme.flaky) }
                }
                .font(Theme.mono(11))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 5).fill(Theme.raised))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(rep.trace?.focus.contains(name) == true ? Theme.fail.opacity(0.5) : Theme.line))
              }
            }
          }
        }
        if let warnings = rep.warnings, !warnings.isEmpty {
          Panel("warnings", tint: Theme.flaky.opacity(0.4), titleColor: Theme.flaky) {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(warnings, id: \.self) { w in Text("▲ \(w)").font(Theme.mono(11)).foregroundStyle(Theme.dim) }
            }
          }
        }
        if let error = rep.error {
          Panel("error", tint: Theme.error.opacity(0.5), titleColor: Theme.error) {
            Text(error).font(Theme.mono(11.5)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
        }
        if let webhooks = rep.webhooks, !webhooks.isEmpty {
          Panel("payment webhooks") {
            VStack(alignment: .leading, spacing: 5) {
              ForEach(webhooks, id: \.event) { w in
                HStack(spacing: 10) {
                  Text(w.event).foregroundStyle(Theme.faint)
                  Text(w.type).foregroundStyle(Theme.text)
                  if let c = w.charge { Text(c).foregroundStyle(Theme.accent) }
                  Spacer()
                  Text(w.deliveries.map { d in d.status.map(String.init) ?? (d.error ?? "–") }.joined(separator: " · "))
                    .foregroundStyle(w.deliveries.count > 1 ? Theme.flaky : Theme.dim)
                  Text("×\(w.deliveries.count)").foregroundStyle(w.deliveries.count > 1 ? Theme.flaky : Theme.faint)
                }
                .font(Theme.mono(11))
              }
            }
          }
        }
      } else {
        LoadingBlock()
      }
    }
  }
}

struct DivergenceCallout: View {
  let divergence: Divergence
  let lane: LaneView
  let reference: LaneView?

  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text("◆").font(Theme.mono(18, .bold)).foregroundStyle(Theme.fail)
          .phaseAnimator([0.5, 1]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.9) }
      }
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          Text("first divergence").label(Theme.fail)
          Text("at \(Fmt.ms(divergence.at)) · \(divergence.tab)").font(Theme.mono(10.5)).foregroundStyle(Theme.dim)
        }
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
          GridRow {
            Text("this run").font(Theme.mono(10.5)).foregroundStyle(Theme.fail)
            Text(divergence.ours).font(Theme.mono(12)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
          GridRow {
            Text(reference.map { $0.run == lane.run ? "rep \($0.rep)" : "passing" } ?? "reference").font(Theme.mono(10.5)).foregroundStyle(Theme.pass)
            Text(divergence.theirs).font(Theme.mono(12)).foregroundStyle(Theme.dim).textSelection(.enabled)
          }
        }
        Text("The two runs did the same until here: the bug is in what happens at this step.").font(Theme.sans(12)).foregroundStyle(Theme.faint)
      }
      Spacer()
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.fail.opacity(0.06)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.fail.opacity(0.35)))
    .rise(0.05)
  }
}

struct RulesPanel: View {
  let rules: [RuleResult]
  @State private var showHeld = false

  var body: some View {
    let broken = rules.filter { !$0.ok }
    let held = rules.filter(\.ok)
    Panel(broken.isEmpty ? "rules" : "rules broken", tint: broken.isEmpty ? Theme.lineStrong : Theme.fail.opacity(0.45), titleColor: broken.isEmpty ? Theme.dim : Theme.fail, accessory: {
      Text("\(held.count)/\(rules.count) held").font(Theme.mono(10)).foregroundStyle(Theme.faint)
    }) {
      VStack(alignment: .leading, spacing: 16) {
        ForEach(broken) { rule in
          VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
              Text("✗").font(Theme.mono(13, .bold)).foregroundStyle(Theme.fail)
              Text(rule.id).font(Theme.mono(13, .semibold)).foregroundStyle(Theme.text)
              if let n = rule.rows?.count { Text("\(n) row\(n == 1 ? "" : "s")").font(Theme.mono(10.5)).foregroundStyle(Theme.faint) }
            }
            if let d = rule.description { Text(d).font(Theme.sans(12.5)).foregroundStyle(Theme.dim) }
            if let sql = rule.sql {
              Text(SQL.highlight(sql)).font(Theme.mono(11)).textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 5).fill(Theme.bg))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.line))
            }
            if let rows = rule.rows, !rows.isEmpty { RowsTable(rows: Array(rows.prefix(8)), tint: Theme.fail) }
            if let e = rule.error { Text(e).font(Theme.mono(11)).foregroundStyle(Theme.error) }
          }
        }
        if !held.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Button {
              withAnimation(Theme.spring) { showHeld.toggle() }
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(showHeld ? 90 : 0))
                Text("\(held.count) rule\(held.count == 1 ? "" : "s") held")
              }
              .font(Theme.mono(11)).foregroundStyle(Theme.dim)
            }
            .buttonStyle(.plain)
            if showHeld || broken.isEmpty {
              FlowLayout(spacing: 6) {
                ForEach(held) { rule in
                  Text("✓ \(rule.id)").font(Theme.mono(10.5)).foregroundStyle(Theme.pass.opacity(0.85))
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.pass.opacity(0.06)))
                    .help(rule.description ?? rule.id)
                }
              }
              .transition(.opacity)
            }
          }
        }
      }
    }
  }
}

/// Rows of JSON objects as a small table.
struct RowsTable: View {
  let rows: [JSONValue]
  var tint: Color = Theme.dim

  var body: some View {
    let columns = rows.first?.fields.map(\.0) ?? []
    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 4) {
      GridRow {
        ForEach(columns, id: \.self) { c in Text(c).font(Theme.mono(10)).foregroundStyle(Theme.faint) }
      }
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        GridRow {
          ForEach(row.fields, id: \.0) { _, v in
            Text(Short.value(v)).font(Theme.mono(11)).foregroundStyle(tint == Theme.dim ? Theme.text : tint).lineLimit(1)
          }
        }
      }
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 5).fill(tint.opacity(0.05)))
  }
}

enum Short {
  /// Values as the viewer shows them: timestamps without the zone, long text cut.
  static func value(_ v: JSONValue, max: Int = 48) -> String {
    let s = v.description
    if let r = s.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?"#, options: .regularExpression) {
      return String(s[r]).replacingOccurrences(of: "T", with: " ")
    }
    return s.count > max ? String(s.prefix(max - 1)) + "…" : s
  }
}

/// Lays children out in rows, wrapping at the width.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width { y += line + spacing; x = 0; line = 0 }
      x += size.width + spacing
      widest = max(widest, x - spacing)
      line = max(line, size.height)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX { y += line + spacing; x = bounds.minX; line = 0 }
      s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}

/// Values given on the command line (`--pane runs --run <id> --tab timeline`), for opening the app at a place.
enum Launch {
  static func value(_ flag: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: flag), args.count > i + 1 else { return nil }
    return args[i + 1]
  }
}

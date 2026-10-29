import SwiftUI

enum RunTab: String, CaseIterable {
  case summary, timeline, trace, database, network, log

  var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
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

  var body: some View {
    let version = model.runVersions[runID] ?? 0
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if let detail {
          RunHeader(detail: detail, rep: rep)
          HStack(alignment: .center, spacing: 12) {
            TabStrip(items: RunTab.allCases, selection: $tab) { t, _ in
              HStack(spacing: 5) {
                Text(t.title)
                if let badge = badge(t) {
                  Text(badge).font(Theme.sans(11)).monospacedDigit().foregroundStyle(Theme.ghost)
                }
              }
            }
            Spacer(minLength: 12)
            if detail.total > 1 {
              HStack(spacing: 4) {
                Text("Repetition").label()
                RepDots(
                  outcomes: detail.reps.map(\.outcome),
                  pending: max(0, detail.total - detail.reps.count),
                  selected: selectedRep
                ) { n in withAnimation(Theme.spring) { selectedRep = n } }
              }
            }
          }
          .padding(.top, 24)
          Hairline()
          Group {
            switch tab {
            case .summary: SummaryTab(detail: detail, rep: rep, comparison: comparison) { t in withAnimation(Theme.spring) { tab = t } }
            case .timeline: TimelineTab(rep: rep, comparison: comparison)
            case .trace: TraceTab(rep: rep)
            case .database: DatabaseTab(rep: rep)
            case .network: NetworkTab(rep: rep)
            case .log: LogTab(rep: rep)
            }
          }
          .padding(.top, 24)
          .id(tab)
          .transition(.opacity)
        } else if let error {
          EmptyState(title: "Couldn't open this run", text: error).frame(height: 400)
        } else {
          LoadingBlock()
        }
      }
      .padding(.horizontal, 28)
      .padding(.top, 10)
      .padding(.bottom, 32)
      .frame(maxWidth: 1100, alignment: .leading)
    }
    .scrollIndicators(.automatic)
    .animation(Theme.spring, value: tab)
    .task(id: "\(runID)#\(version)") { await loadRun() }
    .task(id: "\(runID)#\(version)#\(selectedRep ?? -1)") { await loadRep() }
  }

  private func badge(_ t: RunTab) -> String? {
    guard let rep else { return nil }
    switch t {
    case .summary: return nil
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

struct LoadingBlock: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(0..<4, id: \.self) { i in
        RoundedRectangle(cornerRadius: 3).fill(Color.white.opacity(0.06)).frame(width: [420, 300, 520, 260][i], height: 10)
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

  var body: some View {
    let outcome = detail.result?.outcome ?? "running"
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: 8) {
        Text(detail.experiment.id)
          .font(Theme.sans(20, .semibold)).tracking(-0.2)
          .foregroundStyle(Theme.text)
          .textSelection(.enabled)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .layoutPriority(1)
        Spacer(minLength: 12)
        Button {
          model.runExperiments([detail.experiment.id])
        } label: {
          Label("Run again", systemImage: "arrow.clockwise")
        }
        .buttonStyle(ActionButtonStyle())
        .disabled(model.runningJob != nil)
        if outcome != "pass" {
          Button("Fix") { model.openInClaudeCode(fixPrompt) }
            .buttonStyle(ActionButtonStyle(prominent: true))
            .help("Opens Claude Code in this app's folder with a fix prompt typed, not sent. It runs on your own login when you press Return.")
        }
      }
      HStack(spacing: 10) {
        OutcomeBadge(outcome: outcome)
        Text(meta).font(Theme.sans(12)).foregroundStyle(Theme.faint).lineLimit(1)
      }
      .padding(.top, 6)
      .help(details)
      if let d = detail.experiment.description {
        Text(d).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(3).lineLimit(3)
          .frame(maxWidth: 680, alignment: .leading)
          .padding(.top, 14)
      }
    }
    .rise()
  }

  private var meta: String {
    var parts: [String] = []
    if let started = ISO.date(detail.result?.startedAt) { parts.append("\(Fmt.day(started).capitalized) at \(Fmt.clock(started))") }
    if let ms = detail.result?.durationMs { parts.append(Fmt.ms(ms)) }
    parts.append(Fmt.plural(detail.total, "repetition"))
    return parts.joined(separator: "  ·  ")
  }

  /// The rest, for a tooltip: flow, version, orderings, how it was sorted, what it's compared with.
  private var details: String {
    var lines: [String] = []
    if let flow = detail.experiment.flow { lines.append("Flow: \(flow)") }
    if let label = detail.result?.version?.label { lines.append("Code: \(label)") }
    if let variants = detail.result?.variants, !variants.isEmpty {
      lines.append("Orderings: " + variants.map { "\($0.variant) \($0.ok)/\($0.runs) held" }.joined(separator: ", "))
    }
    if let triage = detail.triage { lines.append("Sorted as \(triage.label ?? "unsorted") by \(triage.by): \(triage.reason)") }
    if let ref = detail.reference { lines.append("Compared with \(ref.label)") }
    return lines.joined(separator: "\n")
  }

  private var fixPrompt: String {
    "Wind Tunnel run \(detail.id) (experiment \(detail.experiment.id)) broke a rule. Read its evidence with windtunnel_evidence handle=\(detail.id), find the cause, fix it, then prove the fix with /windtunnel:prove \(detail.experiment.id)."
  }
}

// MARK: - Summary

/// A run in reading order: what went wrong and where it started, then which tab to open next,
/// then the rest of the evidence.
struct SummaryTab: View {
  let detail: RunDetail
  let rep: RepView?
  let comparison: Comparison?
  let open: (RunTab) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 32) {
      if let rep {
        Verdict(detail: detail, rep: rep, comparison: comparison)
        let leads = leads(rep)
        if !leads.isEmpty {
          Panel("Look next") {
            VStack(spacing: 0) {
              ForEach(leads, id: \.tab) { lead in
                LeadRow(tab: lead.tab, text: lead.text) { open(lead.tab) }
              }
            }
            .padding(.horizontal, -10)
          }
          .rise(0.08)
        }
        RulesPanel(rules: rep.rules)
        if let diff = rep.diff, !diff.tables.isEmpty {
          Panel("Database changes") {
            FlowLayout(spacing: 22, lineSpacing: 8) {
              ForEach(diff.tables.keys.sorted(), id: \.self) { name in
                let t = diff.tables[name]!
                let focus = rep.rules.contains { !$0.ok } && rep.trace?.focus.contains(name) == true
                HStack(spacing: 6) {
                  Text(name).foregroundStyle(focus ? Theme.fail : Theme.text.opacity(0.9))
                  Text(counts(t)).foregroundStyle(Theme.faint)
                }
                .font(Theme.mono(12))
                .help(focus ? "A broken rule reads this table" : name)
              }
            }
          }
        }
        if let warnings = rep.warnings, !warnings.isEmpty {
          Panel("Warnings", tint: Theme.flaky) {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(warnings, id: \.self) { w in Text(w).font(Theme.sans(12.5)).foregroundStyle(Theme.dim) }
            }
          }
        }
        if let webhooks = rep.webhooks, !webhooks.isEmpty {
          Panel("Payment webhooks") {
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
              ForEach(webhooks, id: \.event) { w in
                GridRow {
                  Text(w.type).foregroundStyle(Theme.text.opacity(0.9))
                  Text(w.charge ?? "").foregroundStyle(Theme.dim)
                  Text(w.deliveries.map { d in d.status.map(String.init) ?? (d.error ?? "–") }.joined(separator: " · "))
                    .foregroundStyle(Theme.dim)
                  Text(w.deliveries.count > 1 ? "delivered \(w.deliveries.count)×" : "")
                    .foregroundStyle(Theme.flaky)
                }
                .font(Theme.mono(11.5))
              }
            }
          }
        }
      } else {
        LoadingBlock()
      }
    }
  }

  /// The tabs worth opening for this repetition, most telling first. None when it held.
  private func leads(_ rep: RepView) -> [(tab: RunTab, text: String)] {
    guard rep.outcome != "ok" else { return [] }
    var out: [(tab: RunTab, text: String)] = []
    if comparison != nil {
      out.append((.timeline, "Both runs step by step, from where they split"))
    } else {
      out.append((.timeline, "Each tab and webhook on one time axis"))
    }
    if let focus = rep.trace?.focus, !focus.isEmpty {
      out.append((.trace, "Every write to \(focus.joined(separator: ", ")), and the code behind it"))
    }
    if rep.error != nil {
      out.append((.log, "The app's log up to the error"))
    }
    let notable = rep.requests.filter(\.notable).count
    if notable > 0 {
      out.append((.network, "\(Fmt.plural(notable, "request")) worth a look"))
    }
    if let diff = rep.diff, !diff.tables.isEmpty {
      out.append((.database, "\(Fmt.plural(diff.tables.count, "table")) changed, row by row"))
    }
    return Array(out.prefix(3))
  }

  private func counts(_ t: DbDiff.Table) -> String {
    var parts: [String] = []
    if !t.added.isEmpty { parts.append("+\(t.added.count)") }
    if !t.removed.isEmpty { parts.append("−\(t.removed.count)") }
    if !t.changed.isEmpty { parts.append("~\(t.changed.count)") }
    return parts.joined(separator: " ")
  }
}

/// The answer first: the promise that broke, in words, with the rows that break it, and where
/// this run first went another way than one that held. A rule down the side in the outcome's
/// colour.
struct Verdict: View {
  let detail: RunDetail
  let rep: RepView
  let comparison: Comparison?

  var body: some View {
    let broken = rep.rules.filter { !$0.ok }
    let tone: Tone = !broken.isEmpty ? .fail : rep.error != nil ? .error : .pass
    HStack(alignment: .top, spacing: 18) {
      Rectangle().fill(tone == .pass ? Theme.lineStrong : tone.color).frame(width: 2)
      VStack(alignment: .leading, spacing: 26) {
        if !broken.isEmpty {
          ForEach(broken) { rule in
            VStack(alignment: .leading, spacing: 0) {
              Text(label("Rule broken")).font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.fail)
              Text(rule.description ?? rule.id)
                .font(Theme.sans(17, .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
              if rule.description != nil {
                Text(rule.id).font(Theme.mono(11.5)).foregroundStyle(Theme.faint).textSelection(.enabled).padding(.top, 4)
              }
              if let rows = rule.rows, !rows.isEmpty {
                RowsTable(rows: Array(rows.prefix(8)))
                  .padding(.top, 14)
                if rows.count > 8 {
                  Text("and \(rows.count - 8) more rows").font(Theme.sans(12)).foregroundStyle(Theme.faint).padding(.top, 6)
                }
              }
              if let e = rule.error { Text(e).font(Theme.mono(11)).foregroundStyle(Theme.error).padding(.top, 8) }
            }
          }
        } else if let error = rep.error {
          VStack(alignment: .leading, spacing: 6) {
            Text(label("Didn't finish")).font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.error)
            Text(error).font(Theme.mono(12.5)).foregroundStyle(Theme.text).textSelection(.enabled)
              .fixedSize(horizontal: false, vertical: true)
          }
        } else {
          VStack(alignment: .leading, spacing: 6) {
            Text(label(otherRepsBroke > 0 ? "This repetition held" : "Held")).font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.dim)
            Text("Every rule held").font(Theme.sans(17, .semibold)).tracking(-0.2).foregroundStyle(Theme.text)
            Text(otherRepsBroke > 0
              ? "\(otherRepsBroke) of \(detail.total) repetitions broke a rule: pick a red dot above to see one."
              : "\(Fmt.plural(rep.rules.count, "rule")) checked after the run.")
              .font(Theme.sans(13)).foregroundStyle(Theme.dim)
          }
        }
        if let comparison, let i = comparison.divergence.firstIndex(where: { $0 != nil }), let d = comparison.divergence[i] {
          Divergence(divergence: d, lane: comparison.lanes[i], reference: comparison.reference >= 0 ? comparison.lanes[comparison.reference] : nil)
        }
      }
      .padding(.vertical, 2)
    }
    .fixedSize(horizontal: false, vertical: true)
    .rise(0.04)
  }

  private var brokenReps: Int { detail.reps.filter { $0.outcome != "ok" }.count }
  private var otherRepsBroke: Int { rep.outcome == "ok" ? brokenReps : 0 }

  /// `Rule broken · in 2 of 2 repetitions`, when it was repeated.
  private func label(_ head: String) -> String {
    detail.total > 1 && rep.outcome != "ok" ? "\(head)  ·  in \(brokenReps) of \(detail.total) repetitions" : head
  }

  /// Where this run first went another way than one that held: the two steps one above the other.
  private struct Divergence: View {
    let divergence: WindTunnel.Divergence
    let lane: LaneView
    let reference: LaneView?

    var body: some View {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text("Where it started").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
          Text("\(Fmt.ms(divergence.at)) in, \(divergence.tab)").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 6) {
          GridRow {
            Text("This run").font(Theme.sans(12)).foregroundStyle(Theme.faint)
            Text(divergence.ours).font(Theme.mono(12)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
          GridRow {
            Text(reference.map { $0.run == lane.run ? "Repetition \($0.rep)" : "Passing run" } ?? "Reference").font(Theme.sans(12)).foregroundStyle(Theme.faint)
            Text(divergence.theirs).font(Theme.mono(12)).foregroundStyle(Theme.dim).textSelection(.enabled)
          }
        }
      }
      .help("Both runs did the same up to this step: the bug is in what happens here.")
    }
  }
}

/// A tab worth opening, and why: the whole row opens it.
private struct LeadRow: View {
  let tab: RunTab
  let text: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 14) {
        Text(tab.title).font(Theme.sans(13, .medium)).foregroundStyle(Theme.text).frame(width: 74, alignment: .leading)
        Text(text).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineLimit(1)
        Spacer(minLength: 8)
        Image(systemName: "arrow.right").font(.system(size: 11, weight: .medium)).foregroundStyle(hovering ? Theme.text : Theme.ghost)
      }
      .padding(.horizontal, 10)
      .frame(height: 34)
      .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

/// How each rule is checked: the query for each broken one, then the ones that held.
struct RulesPanel: View {
  let rules: [RuleResult]
  @State private var showHeld = false

  var body: some View {
    let broken = rules.filter { !$0.ok }
    let held = rules.filter(\.ok)
    Panel("Rules", accessory: {
      Text("\(held.count) of \(rules.count) held")
    }) {
      VStack(alignment: .leading, spacing: 16) {
        ForEach(broken.filter { $0.sql != nil }) { rule in
          VStack(alignment: .leading, spacing: 8) {
            if broken.count > 1 { Text(rule.id).font(Theme.mono(12)).foregroundStyle(Theme.fail) }
            Text(SQL.highlight(rule.sql ?? "")).font(Theme.mono(11.5)).textSelection(.enabled).lineSpacing(2)
              .well(padding: 14)
          }
        }
        if !held.isEmpty {
          VStack(alignment: .leading, spacing: 12) {
            if !broken.isEmpty {
              Button {
                withAnimation(Theme.spring) { showHeld.toggle() }
              } label: {
                HStack(spacing: 6) {
                  Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(showHeld ? 90 : 0))
                  Text("\(held.count) held")
                }
                .font(Theme.sans(12.5)).foregroundStyle(Theme.dim)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            }
            if showHeld || broken.isEmpty {
              FlowLayout(spacing: 20, lineSpacing: 8) {
                ForEach(held) { rule in
                  Text(rule.id).font(Theme.mono(11.5)).foregroundStyle(Theme.faint)
                    .help(rule.description ?? rule.id)
                }
              }
              .padding(.leading, broken.isEmpty ? 0 : 15)
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
    Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 5) {
      GridRow {
        ForEach(columns, id: \.self) { c in Text(c).font(Theme.mono(11)).foregroundStyle(Theme.faint) }
      }
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        GridRow {
          ForEach(row.fields, id: \.0) { _, v in
            Text(Short.value(v)).font(Theme.mono(11.5)).foregroundStyle(Theme.text).lineLimit(1)
          }
        }
      }
    }
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
  var lineSpacing: CGFloat? = nil

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
    for s in subviews {
      let size = s.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width { y += line + (lineSpacing ?? spacing); x = 0; line = 0 }
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
      if x > bounds.minX && x + size.width > bounds.maxX { y += line + (lineSpacing ?? spacing); x = bounds.minX; line = 0 }
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

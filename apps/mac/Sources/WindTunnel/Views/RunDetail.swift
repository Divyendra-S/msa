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
      VStack(alignment: .leading, spacing: 20) {
        if let detail {
          RunHeader(detail: detail, rep: rep, selectedRep: $selectedRep)
          Segmented(items: RunTab.allCases, selection: $tab) { t, _ in
            HStack(spacing: 5) {
              Text(t.title)
              if let badge = badge(t) {
                Text(badge).font(Theme.sans(10.5, .semibold)).monospacedDigit()
                  .foregroundStyle(t == .summary ? Theme.fail : Theme.faint)
              }
            }
          }
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
      .padding(.horizontal, 26)
      .padding(.top, 8)
      .padding(.bottom, 28)
      .frame(maxWidth: 1240, alignment: .leading)
    }
    .scrollIndicators(.automatic)
    .animation(Theme.spring, value: tab)
    .task(id: "\(runID)#\(version)") { await loadRun() }
    .task(id: "\(runID)#\(version)#\(selectedRep ?? -1)") { await loadRep() }
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

struct LoadingBlock: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(0..<4, id: \.self) { i in
        Capsule().fill(Color.white.opacity(0.06)).frame(width: [420, 300, 520, 260][i], height: 12)
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
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .center, spacing: 12) {
        Text(detail.experiment.id)
          .font(Theme.sans(22, .semibold)).tracking(-0.3)
          .foregroundStyle(Theme.text)
          .textSelection(.enabled)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
          .layoutPriority(1)
        OutcomeBadge(outcome: outcome, large: true)
        Spacer(minLength: 12)
        Button {
          model.runExperiments([detail.experiment.id])
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(GlassButtonStyle())
        .disabled(model.runningJob != nil)
        .help("Run again")
        if outcome != "pass" {
          Button {
            model.openInClaudeCode(fixPrompt)
          } label: {
            Label("Fix", systemImage: "sparkles")
          }
          .buttonStyle(GlassButtonStyle(prominent: true))
          .help("Fix in Claude Code: opens it in this app's folder with the prompt typed, not sent. It runs on your own login when you press Return.")
        }
      }
      VStack(alignment: .leading, spacing: 6) {
        Text(meta).font(Theme.sans(12)).foregroundStyle(Theme.faint)
        if let d = detail.experiment.description {
          Text(d).font(Theme.sans(13)).foregroundStyle(Theme.dim).lineSpacing(2).lineLimit(3).frame(maxWidth: 720, alignment: .leading)
        }
      }
      HStack(alignment: .top, spacing: 30) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Repetitions").label()
          RepDots(
            outcomes: detail.reps.map(\.outcome),
            pending: max(0, detail.total - detail.reps.count),
            selected: selectedRep
          ) { n in withAnimation(Theme.spring) { selectedRep = n } }
          .padding(.leading, -4)
        }
        if let variants = detail.result?.variants, !variants.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Text("Orderings").label()
            HStack(spacing: 12) {
              ForEach(variants, id: \.variant) { v in
                HStack(spacing: 5) {
                  Circle().fill(Tone(v.outcome).color).frame(width: 5, height: 5)
                  Text("\(v.variant) \(v.ok)/\(v.runs)").font(Theme.mono(11)).foregroundStyle(Theme.dim)
                }
                .fixedSize()
                .help("\(v.variant): \(v.ok) of \(v.runs) held every rule")
              }
            }
            .frame(height: 18)
          }
        }
        if let triage = detail.triage {
          VStack(alignment: .leading, spacing: 6) {
            Text("Sorted").label()
            Text("\(triage.label ?? "sorted") · \(triage.by)")
              .font(Theme.sans(12, .medium))
              .foregroundStyle(triage.label == "bug" ? Theme.fail : Theme.flaky)
              .frame(height: 18)
              .help(triage.reason)
          }
        }
        if let ref = detail.reference {
          VStack(alignment: .leading, spacing: 6) {
            Text("Compared with").label()
            Text(ref.run == detail.id ? "repetition \(ref.rep)" : "a passing run")
              .font(Theme.sans(12, .medium)).foregroundStyle(Theme.pass.opacity(0.9))
              .frame(height: 18)
              .help(ref.label)
          }
        }
      }
    }
    .rise()
  }

  private var meta: String {
    var parts: [String] = []
    if let started = ISO.date(detail.result?.startedAt) { parts.append("\(Fmt.day(started).capitalized) at \(Fmt.clock(started))") }
    if let ms = detail.result?.durationMs { parts.append(Fmt.ms(ms)) }
    parts.append(Fmt.plural(detail.total, "repetition"))
    if let flow = detail.experiment.flow { parts.append(flow) }
    if let label = detail.result?.version?.label { parts.append(label) }
    return parts.joined(separator: "  ·  ")
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
    VStack(alignment: .leading, spacing: 16) {
      if let comparison, let i = comparison.divergence.firstIndex(where: { $0 != nil }), let d = comparison.divergence[i] {
        DivergenceCallout(divergence: d, lane: comparison.lanes[i], reference: comparison.reference >= 0 ? comparison.lanes[comparison.reference] : nil)
      }
      if let rep {
        RulesPanel(rules: rep.rules)
        if let diff = rep.diff, !diff.tables.isEmpty {
          Panel("Database changes") {
            FlowLayout(spacing: 6) {
              ForEach(diff.tables.keys.sorted(), id: \.self) { name in
                let t = diff.tables[name]!
                let focus = rep.rules.contains { !$0.ok } && rep.trace?.focus.contains(name) == true
                HStack(spacing: 6) {
                  Text(name).foregroundStyle(Theme.text)
                  if !t.added.isEmpty { Text("+\(t.added.count)").foregroundStyle(Theme.pass) }
                  if !t.removed.isEmpty { Text("−\(t.removed.count)").foregroundStyle(Theme.fail) }
                  if !t.changed.isEmpty { Text("~\(t.changed.count)").foregroundStyle(Theme.flaky) }
                }
                .font(Theme.mono(11))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(focus ? Theme.fail.opacity(0.1) : Color.white.opacity(0.05)))
                .overlay(Capsule().strokeBorder(focus ? Theme.fail.opacity(0.35) : .clear, lineWidth: 1))
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
        if let error = rep.error {
          Panel("Error", tint: Theme.error) {
            Text(error).font(Theme.mono(11.5)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
        }
        if let webhooks = rep.webhooks, !webhooks.isEmpty {
          Panel("Payment webhooks") {
            VStack(alignment: .leading, spacing: 7) {
              ForEach(webhooks, id: \.event) { w in
                HStack(spacing: 10) {
                  Text(w.type).foregroundStyle(Theme.text)
                  if let c = w.charge { Text(c).foregroundStyle(Theme.accent) }
                  Text(w.event).foregroundStyle(Theme.ghost)
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
    HStack(alignment: .top, spacing: 14) {
      Circle().fill(Theme.fail).frame(width: 8, height: 8).padding(.top, 5)
        .background(Circle().fill(Theme.fail.opacity(0.3)).frame(width: 18, height: 18).padding(.top, 5)
          .phaseAnimator([0.4, 1]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 1.1) })
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("First divergence").font(Theme.sans(13.5, .semibold)).foregroundStyle(Theme.fail)
          Text("\(Fmt.ms(divergence.at)) · \(divergence.tab)").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
          GridRow {
            Text("This run").font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.fail.opacity(0.85))
            Text(divergence.ours).font(Theme.mono(12)).foregroundStyle(Theme.text).textSelection(.enabled)
          }
          GridRow {
            Text(reference.map { $0.run == lane.run ? "Rep \($0.rep)" : "Passing" } ?? "Reference").font(Theme.sans(11.5, .medium)).foregroundStyle(Theme.pass.opacity(0.85))
            Text(divergence.theirs).font(Theme.mono(12)).foregroundStyle(Theme.dim).textSelection(.enabled)
          }
        }
      }
      Spacer()
    }
    .padding(18)
    .card(tint: Theme.fail)
    .help("Both runs did the same up to this step: the bug is in what happens here.")
    .rise(0.05)
  }
}

struct RulesPanel: View {
  let rules: [RuleResult]
  @State private var showHeld = false

  var body: some View {
    let broken = rules.filter { !$0.ok }
    let held = rules.filter(\.ok)
    Panel("Rules", accessory: { Text("\(held.count) of \(rules.count) held") }) {
      VStack(alignment: .leading, spacing: 18) {
        ForEach(broken) { rule in
          VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
              Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(Theme.fail)
              Text(rule.id).font(Theme.mono(12.5, .medium)).foregroundStyle(Theme.text)
              if let n = rule.rows?.count { Text(Fmt.plural(n, "row")).font(Theme.sans(11.5)).foregroundStyle(Theme.faint) }
            }
            if let d = rule.description { Text(d).font(Theme.sans(12.5)).foregroundStyle(Theme.dim) }
            if let sql = rule.sql {
              Text(SQL.highlight(sql)).font(Theme.mono(11)).textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.well))
            }
            if let rows = rule.rows, !rows.isEmpty { RowsTable(rows: Array(rows.prefix(8)), tint: Theme.fail) }
            if let e = rule.error { Text(e).font(Theme.mono(11)).foregroundStyle(Theme.error) }
          }
        }
        if !held.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            if !broken.isEmpty {
              Button {
                withAnimation(Theme.spring) { showHeld.toggle() }
              } label: {
                HStack(spacing: 6) {
                  Image(systemName: "chevron.right").font(.system(size: 9, weight: .bold)).rotationEffect(.degrees(showHeld ? 90 : 0))
                  Text("\(held.count) held")
                }
                .font(Theme.sans(12, .medium)).foregroundStyle(Theme.dim)
              }
              .buttonStyle(.plain)
            }
            if showHeld || broken.isEmpty {
              FlowLayout(spacing: 6) {
                ForEach(held) { rule in
                  HStack(spacing: 5) {
                    Image(systemName: "checkmark").font(.system(size: 8.5, weight: .bold))
                    Text(rule.id).font(Theme.mono(10.5))
                  }
                  .foregroundStyle(Theme.pass.opacity(0.85))
                  .padding(.horizontal, 9).padding(.vertical, 4)
                  .background(Capsule().fill(Theme.pass.opacity(0.08)))
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
    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 5) {
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
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.well))
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

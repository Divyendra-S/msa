import SwiftUI

struct TimelineTab: View {
  let rep: RepView?
  let comparison: Comparison?

  var body: some View {
    VStack(alignment: .leading, spacing: 30) {
      if let rep {
        Panel("Race", rule: false, accessory: {
          Text("Repetition \(rep.rep) · \(Fmt.ms(rep.durationMs)) · \(rep.variant)")
        }) {
          RaceView(rep: rep, divergent: divergentIDs)
        }
      } else {
        LoadingBlock2()
      }
      if let comparison {
        Panel("Side by side") {
          AlignedView(comparison: comparison)
        }
      }
    }
  }

  /// This repetition's requests where it first went another way than the reference.
  private var divergentIDs: Set<Int> {
    guard let comparison else { return [] }
    var ids = Set<Int>()
    for row in comparison.rows {
      if let cell = row.cells.first ?? nil { for r in cell.requests where r.divergent == true { ids.insert(r.id) } }
    }
    return ids
  }
}

private struct LoadingBlock2: View {
  var body: some View {
    HStack(spacing: 8) {
      BrailleSpinner()
      Text("Lining up the steps").font(Theme.sans(12)).foregroundStyle(Theme.dim)
    }
  }
}

/// Every actor (browser tab, the payment provider's webhooks) on one time axis: steps as bars,
/// the requests they made as ticks under them. Overlaps are the races.
struct RaceView: View {
  let rep: RepView
  let divergent: Set<Int>
  @State private var hover: HoverItem?
  @State private var grown = false

  enum HoverItem: Equatable {
    case step(StepRecord)
    case request(RequestView)
    case webhook(String, Double, Int?)
  }

  private var lanes: [String] {
    var out: [String] = []
    for s in rep.steps where !out.contains(s.tab) { out.append(s.tab) }
    for r in rep.requests { if let t = r.tab, !out.contains(t) { out.append(t) } }
    return out
  }

  private var deliveries: [(String, Double, Int?)] {
    guard let start = ISO.date(rep.startedAt) else { return [] }
    return (rep.webhooks ?? []).flatMap { w in
      w.deliveries.compactMap { d in ISO.date(d.at).map { (w.type + " " + (w.charge ?? ""), $0.timeIntervalSince(start) * 1000, d.status) } }
    }
  }

  private var span: Double {
    let ends = rep.steps.map(\.end) + rep.requests.map { $0.end ?? $0.start } + deliveries.map(\.1)
    return max(100, (ends.max() ?? 1000) * 1.03)
  }

  var body: some View {
    let lanes = lanes
    let webhooks = deliveries
    let rows = lanes.count + (webhooks.isEmpty ? 0 : 1)
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 0) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lanes.enumerated()), id: \.element) { i, lane in
            laneLabel(lane, color: Theme.actor(i))
          }
          if !webhooks.isEmpty { laneLabel("webhooks", color: Theme.dim) }
        }
        .frame(width: 96)
        GeometryReader { geo in
          let w = geo.size.width
          ZStack(alignment: .topLeading) {
            grid(width: w, height: CGFloat(rows) * 56)
            ForEach(Array(lanes.enumerated()), id: \.element) { i, lane in
              let y = CGFloat(i) * 56
              ForEach(Array(rep.steps.filter { $0.tab == lane }.enumerated()), id: \.offset) { j, step in
                stepBar(step, color: Theme.actor(i), width: w)
                  .offset(x: x(step.start, w), y: y + 8)
                  .scaleEffect(x: grown ? 1 : 0.001, anchor: .leading)
                  .animation(Theme.spring.delay(Double(i) * 0.06 + Double(j) * 0.02), value: grown)
              }
              ForEach(rep.requests.filter { $0.tab == lane && ($0.notable || divergent.contains($0.id)) }) { r in
                requestTick(r, width: w)
                  .offset(x: x(r.start, w), y: y + 34)
                  .opacity(grown ? 1 : 0)
                  .animation(.easeOut(duration: 0.4).delay(0.25 + Double(i) * 0.06), value: grown)
              }
            }
            if !webhooks.isEmpty {
              let y = CGFloat(lanes.count) * 56
              ForEach(Array(webhooks.enumerated()), id: \.offset) { _, d in
                Text("◆")
                  .font(Theme.mono(13, .bold))
                  .foregroundStyle((d.2 ?? 0) >= 400 ? Theme.fail : Theme.dim)
                  .offset(x: x(d.1, w) - 5, y: y + 12)
                  .onHover { inside in hover = inside ? .webhook(d.0, d.1, d.2) : nil }
              }
            }
          }
        }
        .frame(height: CGFloat(rows) * 56)
      }
      axis
      detail.frame(minHeight: 46, alignment: .topLeading)
    }
    .onAppear { grown = true }
  }

  private func x(_ ms: Double, _ width: CGFloat) -> CGFloat { CGFloat(ms / span) * width }

  private func laneLabel(_ name: String, color: Color) -> some View {
    HStack(spacing: 7) {
      RoundedRectangle(cornerRadius: 1).fill(color).frame(width: 3, height: 12)
      Text(name).font(Theme.sans(12)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
    }
    .frame(height: 56, alignment: .center)
  }

  private func grid(width: CGFloat, height: CGFloat) -> some View {
    Canvas { context, size in
      let step = niceStep(span / 8)
      var t = 0.0
      while t <= span {
        let px = CGFloat(t / span) * size.width
        var p = Path()
        p.move(to: CGPoint(x: px, y: 0))
        p.addLine(to: CGPoint(x: px, y: size.height))
        context.stroke(p, with: .color(Theme.line), style: StrokeStyle(lineWidth: 1, dash: [2, 4]))
        t += step
      }
      for i in 1..<max(2, Int(size.height / 56)) {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: CGFloat(i) * 56))
        p.addLine(to: CGPoint(x: size.width, y: CGFloat(i) * 56))
        context.stroke(p, with: .color(Theme.line.opacity(0.6)), lineWidth: 1)
      }
    }
    .frame(width: width, height: height)
  }

  private func stepBar(_ step: StepRecord, color: Color, width: CGFloat) -> some View {
    let w = max(3, x(step.end - step.start, width))
    let isHover = hover == .step(step)
    let harness = !(step.harness ?? []).isEmpty
    return RoundedRectangle(cornerRadius: 3, style: .continuous)
      .fill(color.opacity(isHover ? 0.3 : (step.error != nil ? 0.08 : 0.16)))
      .overlay {
        if step.error != nil || harness {
          RoundedRectangle(cornerRadius: 3, style: .continuous)
            .strokeBorder(step.error != nil ? Theme.fail : color.opacity(0.6), style: StrokeStyle(lineWidth: 1, dash: harness ? [3, 2] : []))
        }
      }
      .overlay(alignment: .leading) {
        if w > 40 {
          Text(step.step + (step.attempt.map { " · \($0)" } ?? ""))
            .font(Theme.mono(10, .medium))
            .foregroundStyle(Theme.text.opacity(0.9))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .frame(width: w, alignment: .leading)
            .clipped()
        }
      }
      .frame(width: w, height: 20)
      .onHover { inside in withAnimation(Theme.snappy) { hover = inside ? .step(step) : (hover == .step(step) ? nil : hover) } }
  }

  private func requestTick(_ r: RequestView, width: CGFloat) -> some View {
    let w = max(3, x((r.end ?? r.start + 10) - r.start, width))
    let bad = (r.status ?? 0) >= 400 || r.failure != nil
    let writes = (r.sql?.writes ?? 0) > 0
    let isDivergent = divergent.contains(r.id)
    let color = isDivergent ? Theme.fail : bad ? Theme.flaky : writes ? Theme.text : Theme.faint
    return RoundedRectangle(cornerRadius: 1)
      .fill(color.opacity(hover == .request(r) ? 1 : 0.8))
      .frame(width: w, height: isDivergent ? 5 : 3)
      .overlay {
        if isDivergent {
          RoundedRectangle(cornerRadius: 2).stroke(Theme.fail, lineWidth: 1).frame(width: w + 6, height: 11)
            .phaseAnimator([0.3, 1]) { v, o in v.opacity(o) } animation: { _ in .easeInOut(duration: 0.8) }
        }
      }
      .padding(.vertical, 4)
      .contentShape(Rectangle())
      .onHover { inside in withAnimation(Theme.snappy) { hover = inside ? .request(r) : (hover == .request(r) ? nil : hover) } }
  }

  private var axis: some View {
    let step = niceStep(span / 8)
    return HStack(spacing: 0) {
      Color.clear.frame(width: 96)
      GeometryReader { geo in
        ZStack(alignment: .topLeading) {
          Rectangle().fill(Theme.line).frame(width: geo.size.width, height: 1)
          ForEach(Array(stride(from: 0.0, through: span, by: step).enumerated()), id: \.offset) { _, t in
            VStack(alignment: .leading, spacing: 4) {
              Rectangle().fill(Theme.ghost).frame(width: 1, height: 4)
              Text(Fmt.ms(t)).font(Theme.sans(11)).monospacedDigit().foregroundStyle(Theme.faint).fixedSize()
            }
            .offset(x: CGFloat(t / span) * geo.size.width)
          }
        }
      }
      .frame(height: 30)
    }
  }

  @ViewBuilder
  private var detail: some View {
    switch hover {
    case .step(let s):
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text("\(s.tab) · \(s.step)\(s.attempt.map { " · \($0)" } ?? "")").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
          Text("\(Fmt.ms(s.start)) → \(Fmt.ms(s.end))  (\(Fmt.ms(s.end - s.start)))").font(Theme.mono(11)).foregroundStyle(Theme.faint)
        }
        ForEach(s.harness ?? [], id: \.self) { h in Text("↺ \(h)").font(Theme.mono(11)).foregroundStyle(Theme.dim) }
        ForEach(Array((s.actions ?? []).prefix(4).enumerated()), id: \.offset) { _, a in
          Text("› \(a.action)").font(Theme.mono(11)).foregroundStyle(Theme.dim).lineLimit(1)
        }
        if let seen = s.seen {
          Text("page \(seen.path): \(seen.text)").font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
        }
        if let e = s.error { Text(e).font(Theme.mono(11)).foregroundStyle(Theme.fail).lineLimit(2) }
      }
    case .request(let r):
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text("\(r.method) \(r.path)").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
          Text(r.status.map(String.init) ?? (r.failure ?? "–")).font(Theme.mono(11)).foregroundStyle((r.status ?? 0) >= 400 ? Theme.fail : Theme.dim)
          Text(Fmt.ms((r.end ?? r.start) - r.start)).font(Theme.mono(11)).foregroundStyle(Theme.faint)
          if divergent.contains(r.id) { Text("first divergence").font(Theme.sans(11, .medium)).foregroundStyle(Theme.fail) }
        }
        HStack(spacing: 10) {
          if let h = r.handler { Text(h).foregroundStyle(Theme.accent.opacity(0.85)) }
          if let sql = r.sql { Text("\(sql.total) statements · \(sql.writes) writes\(sql.errors > 0 ? " · \(sql.errors) errors" : "")").foregroundStyle(Theme.dim) }
          if let step = r.step { Text("step \(step)").foregroundStyle(Theme.faint) }
        }
        .font(Theme.mono(11))
      }
    case .webhook(let what, let at, let status):
      HStack(spacing: 8) {
        Text("Webhook \(what)").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
        Text("at \(Fmt.ms(at)) → \(status.map(String.init) ?? "no answer")").font(Theme.mono(11)).foregroundStyle(Theme.dim)
      }
    case nil:
      Text("Hover a step or a request for its details.")
        .font(Theme.sans(12)).foregroundStyle(Theme.ghost)
        .help("Dashed bars are steps the harness repeated or perturbed; ◆ marks webhook deliveries.")
    }
  }
}

func niceStep(_ raw: Double) -> Double {
  let candidates: [Double] = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000]
  return candidates.first { $0 >= raw } ?? 120_000
}

/// Runs side by side, one row per step, lined up by tab and step name.
struct AlignedView: View {
  let comparison: Comparison

  var body: some View {
    let firstRow = comparison.divergence.compactMap { $0 }.map(\.row).min()
    let tabs = Array(Set(comparison.rows.map(\.tab))).sorted()
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: 12) {
        Text("Step").label().frame(width: 150, alignment: .leading)
        ForEach(Array(comparison.lanes.enumerated()), id: \.offset) { i, lane in
          HStack(spacing: 8) {
            OutcomeBadge(outcome: lane.outcome)
            if i != comparison.reference, !lane.broken.isEmpty {
              Text(lane.broken.joined(separator: ", ")).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
            }
          }
          .help("\(lane.run), repetition \(lane.rep)")
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 10)
      Hairline()
      ForEach(Array(comparison.rows.enumerated()), id: \.offset) { index, row in
        let isFirst = index == firstRow
        HStack(alignment: .top, spacing: 12) {
          VStack(alignment: .leading, spacing: 3) {
            Text(row.step).font(Theme.mono(11, .medium)).foregroundStyle(Theme.text)
            HStack(spacing: 6) {
              RoundedRectangle(cornerRadius: 1).fill(Theme.actor(tabs.firstIndex(of: row.tab) ?? 0)).frame(width: 3, height: 9)
              Text(row.tab).font(Theme.sans(11)).foregroundStyle(Theme.faint)
              if let attempt = row.attempt { Text("↺ \(attempt)").font(Theme.sans(11)).foregroundStyle(Theme.faint) }
            }
            if isFirst {
              Text("First divergence").font(Theme.sans(11, .medium)).foregroundStyle(Theme.fail).padding(.top, 2)
            }
          }
          .frame(width: 150, alignment: .leading)
          ForEach(Array(row.cells.enumerated()), id: \.offset) { _, cell in
            CellView(cell: cell)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 10)
        .background(isFirst ? Theme.fail.opacity(0.06) : .clear)
        .overlay(alignment: .leading) { if isFirst { Rectangle().fill(Theme.fail).frame(width: 2) } }
        .overlay(alignment: .bottom) { Hairline() }
      }
    }
  }
}

private struct CellView: View {
  let cell: LaneStep?

  var body: some View {
    if let cell {
      VStack(alignment: .leading, spacing: 4) {
        if cell.requests.isEmpty && cell.writes == nil {
          Text(cell.quiet ? "no requests" : "–").font(Theme.mono(11)).foregroundStyle(Theme.ghost)
        }
        ForEach(Array(cell.requests.enumerated()), id: \.offset) { _, r in
          HStack(spacing: 6) {
            Text(r.method).foregroundStyle(Theme.faint)
            Text(r.path).foregroundStyle(r.divergent == true ? Theme.fail : Theme.text).lineLimit(1)
            Text(r.status.map(String.init) ?? (r.failure ?? "–")).foregroundStyle((r.status ?? 0) >= 400 || r.failure != nil ? Theme.fail : Theme.faint)
            if let sql = r.sql, sql.writes > 0 {
              Text("\(sql.writes) writes").foregroundStyle(r.divergent == true ? Theme.fail : Theme.dim)
            }
          }
          .font(Theme.mono(11))
        }
        if let writes = cell.writes { Text("\(writes) writes").font(Theme.mono(11)).foregroundStyle(Theme.dim) }
        ForEach(cell.harness, id: \.self) { h in Text("↺ \(h)").font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1) }
        if let seen = cell.seen {
          Text("\(seen.path) · …\(seen.text.split(separator: " ").suffix(7).joined(separator: " "))")
            .font(Theme.mono(10))
            .foregroundStyle(cell.seenDiffers == true ? Theme.dim : Theme.ghost)
            .lineLimit(1)
        }
        if let e = cell.error { Text(e).font(Theme.mono(10)).foregroundStyle(Theme.fail).lineLimit(2) }
      }
    } else {
      Text("(not in this run)").font(Theme.mono(11)).foregroundStyle(Theme.ghost)
    }
  }
}

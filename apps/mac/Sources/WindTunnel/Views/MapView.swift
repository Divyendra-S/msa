import SwiftUI

/// The app as one picture: its pages, the routes they call, and the tables and services those
/// reach, read from the code. Over it, what the experiments went through, where they pushed, and
/// where a rule broke. Point at an experiment to see its way through; click it to follow it step
/// by step. Click anything in the picture for what's behind it.
struct MapPane: View {
  @Environment(AppModel.self) private var model
  @State private var hover: MapHover?

  private var focus: MapFocus {
    get { model.mapFocus }
    nonmutating set { model.mapFocus = newValue }
  }

  var body: some View {
    Group {
      if let map = model.appMap, !(map.pages.isEmpty && map.routes.isEmpty) {
        let graph = MapGraph(map, latest: model.latestByExperiment)
        ScrollView {
          VStack(alignment: .leading, spacing: 36) {
            MapHero(graph: graph).rise()
            HStack(alignment: .top, spacing: 32) {
              Inspector(graph: graph, focus: Binding { model.mapFocus } set: { model.mapFocus = $0 }, hover: $hover)
                .frame(width: 236, alignment: .topLeading)
              Diagram(graph: graph, highlight: highlight(graph), selected: focus.node, hover: $hover) { id in
                withAnimation(Theme.snappy) { focus = focus.node == id ? .app : .node(id) }
              }
              .frame(maxWidth: 760, alignment: .topLeading)
            }
            .rise(0.05)
          }
          .padding(.horizontal, Theme.gutter)
          .padding(.top, 4)
          .padding(.bottom, 32)
          .frame(maxWidth: Theme.measure, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
      } else if model.appMap != nil {
        EmptyState(title: "Nothing to draw yet", text: "No pages or API routes turned up in the code. The map reads Next.js pages, route handlers and server actions.")
      } else if let error = model.appMapError {
        EmptyState(title: "Couldn't read the app", text: error)
      } else {
        VStack(spacing: 14) {
          DitherBar(width: 96)
          Text("Reading the code").font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .task { await model.loadMap() }
  }

  /// What the picture lights: what's pointed at first, else what's chosen.
  private func highlight(_ graph: MapGraph) -> MapGraph.Highlight {
    switch hover {
    case .step(let i):
      if case .experiment(let id) = focus, let e = graph.experiment(id), e.steps.indices.contains(i) { return graph.highlight(e, step: i) }
    case .experiment(let id):
      if let e = graph.experiment(id) { return graph.highlight(e) }
    case .node(let id):
      return graph.highlight(node: id)
    case nil:
      break
    }
    switch focus {
    case .app: return .init()
    case .experiment(let id): return graph.experiment(id).map { graph.highlight($0) } ?? .init()
    case .node(let id): return graph.highlight(node: id)
    }
  }
}

enum MapFocus: Hashable {
  case app
  case experiment(String)
  case node(String)

  var node: String? {
    if case .node(let id) = self { id } else { nil }
  }
}

enum MapHover: Hashable {
  case experiment(String)
  case step(Int)
  case node(String)
}

// MARK: - The graph

/// The picture's three columns (pages, routes, data), the lines between them, and what the
/// experiments went through.
struct MapGraph {
  enum Kind { case page, layout, outside, route, table, service }

  struct Node: Identifiable, Hashable {
    let id: String
    let kind: Kind
    let name: String
  }

  struct Edge: Hashable {
    let from: String
    let to: String
  }

  /// What to light: the nodes, where the experiment in view pushes and how, and whether it broke a rule.
  struct Highlight {
    var lit: Set<String>? = nil
    var pushed: [String: String] = [:]
    var broke = false
    /// Where the rule that broke is put down to.
    var blamed: Set<String> = []
    /// Requests sent per route, when following an experiment or one of its steps.
    var sent: [String: Int]? = nil
    /// Requests drawn moving along the lit lines.
    var flowing = false
  }

  let map: AppMap
  let columns: [[Node]]
  let edges: [Edge]
  let experiments: [AppMap.Experiment]
  /// Each experiment's newest outcome.
  let outcomes: [String: String]
  /// The nodes each experiment went through.
  let nodesOf: [String: Set<String>]
  /// The experiments that went through each node.
  let through: [String: [String]]
  /// Routes a broken rule is put down to (see `blame`).
  let broke: Set<String>
  let testedEdges: Set<Edge>
  let brokeEdges: Set<Edge>
  let pages: [String: AppMap.Page]
  let routes: [String: AppMap.Route]

  static func page(_ path: String) -> String { "p " + path }
  static func layout(_ path: String) -> String { "l " + path }
  static let outside = "o"
  static func route(_ key: String) -> String { "r " + key }
  static func table(_ name: String) -> String { "t " + name }
  static func service(_ key: String) -> String { "s " + key }

  init(_ map: AppMap, latest: [String: RunListEntry]) {
    self.map = map
    experiments = map.experiments
    pages = Dictionary(map.pages.filter { !$0.layout }.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
    routes = Dictionary(map.routes.map { ($0.key, $0) }, uniquingKeysWith: { a, _ in a })
    var outcomes: [String: String] = [:]
    for e in map.experiments { outcomes[e.id] = latest[e.id]?.outcome ?? e.run?.outcome }
    self.outcomes = outcomes

    // Pages most experiments open first, each where its flows reach it; then layouts and webhooks.
    var visits: [String: Int] = [:]
    var depth: [String: Int] = [:]
    for e in map.experiments {
      for (k, p) in e.steps.flatMap(\.pages).enumerated() {
        if k == e.steps.flatMap(\.pages).firstIndex(of: p) { visits[p, default: 0] += 1 }
        depth[p] = min(depth[p] ?? .max, k)
      }
    }
    let plain = map.pages.enumerated().filter { !$0.element.layout }
    let sortedPages = plain.sorted { a, b in
      let x = (visits[a.element.path] ?? 0, -(depth[a.element.path] ?? .max), -a.offset)
      let y = (visits[b.element.path] ?? 0, -(depth[b.element.path] ?? .max), -b.offset)
      return x > y
    }.map(\.element)
    let layouts = map.pages.filter(\.layout)
    let webhooks = map.routes.filter(\.webhook)
    var first: [Node] = sortedPages.map { Node(id: Self.page($0.path), kind: .page, name: $0.path) }
    first += layouts.map { Node(id: Self.layout($0.path), kind: .layout, name: $0.path == "/" ? "Every page" : "Pages under \($0.path)") }
    if !webhooks.isEmpty { first.append(Node(id: Self.outside, kind: .outside, name: "Webhooks")) }

    var edges: [Edge] = []
    for p in sortedPages { for c in p.calls { edges.append(Edge(from: Self.page(p.path), to: Self.route(c))) } }
    for l in layouts { for c in l.calls { edges.append(Edge(from: Self.layout(l.path), to: Self.route(c))) } }
    for r in webhooks { edges.append(Edge(from: Self.outside, to: Self.route(r.key))) }

    // Routes beside what calls them, so the lines cross as little as they can.
    let row = Dictionary(first.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { a, _ in a })
    func callerRow(_ r: AppMap.Route) -> Int {
      edges.filter { $0.to == Self.route(r.key) }.compactMap { row[$0.from] }.min() ?? .max
    }
    let sortedRoutes = map.routes.enumerated().sorted { a, b in
      (callerRow(a.element), a.offset) < (callerRow(b.element), b.offset)
    }.map(\.element)
    let second = sortedRoutes.map { Node(id: Self.route($0.key), kind: .route, name: $0.key) }

    var tableRow: [String: Int] = [:]
    for (i, r) in sortedRoutes.enumerated() {
      for t in r.writes where tableRow[t] == nil { tableRow[t] = i }
      for t in r.writes { edges.append(Edge(from: Self.route(r.key), to: Self.table(t))) }
      for s in r.services { edges.append(Edge(from: Self.route(r.key), to: Self.service(s))) }
    }
    let written = map.tables.filter { tableRow[$0] != nil }.sorted { (tableRow[$0] ?? 0) < (tableRow[$1] ?? 0) }
    let readOnly = map.tables.filter { tableRow[$0] == nil }
    let third = (written + readOnly).map { Node(id: Self.table($0), kind: .table, name: $0) }
      + map.services.map { Node(id: Self.service($0), kind: .service, name: $0) }
    columns = [first, second, third]
    self.edges = edges

    var nodesOf: [String: Set<String>] = [:]
    var through: [String: [String]] = [:]
    var broke = Set<String>()
    for e in map.experiments {
      var set = Set<String>()
      for p in e.pages { set.insert(Self.page(p)) }
      if !e.pages.isEmpty { for l in layouts { set.insert(Self.layout(l.path)) } }
      for key in e.routes {
        set.insert(Self.route(key))
        if routes[key]?.webhook == true { set.insert(Self.outside) }
        for s in routes[key]?.services ?? [] { set.insert(Self.service(s)) }
      }
      for t in e.tables { set.insert(Self.table(t)) }
      nodesOf[e.id] = set
      for id in set { through[id, default: []].append(e.id) }
      if Self.brokeRule(outcomes[e.id]) { broke.formUnion(Self.blame(e, routes)) }
    }
    self.nodesOf = nodesOf
    self.through = through
    self.broke = broke

    var tested = Set<Edge>()
    var brokeEdges = Set<Edge>()
    for e in map.experiments {
      guard let set = nodesOf[e.id] else { continue }
      let blamed = Self.blame(e, routes)
      for edge in edges where set.contains(edge.from) && set.contains(edge.to) {
        tested.insert(edge)
        if Self.brokeRule(outcomes[e.id]) && (blamed.contains(edge.from) || blamed.contains(edge.to)) { brokeEdges.insert(edge) }
      }
    }
    testedEdges = tested
    self.brokeEdges = brokeEdges
  }

  /// Failed, or flaky: a rule broke in at least one repetition.
  static func brokeRule(_ outcome: String?) -> Bool { outcome == "fail" || outcome == "flaky" }

  /// The routes a broken rule is put down to: where the experiment pushes on the requests
  /// themselves. A webhook's timing counts only when that's all it changes; otherwise it's the
  /// setting, not the cause.
  static func blame(_ e: AppMap.Experiment, _ routes: [String: AppMap.Route]) -> Set<String> {
    let all = e.pressure.flatMap(\.routes)
    let direct = all.filter { routes[$0]?.webhook != true }
    return Set((direct.isEmpty ? all : direct).map(route))
  }

  func blame(_ e: AppMap.Experiment) -> Set<String> { Self.blame(e, routes) }

  func experiment(_ id: String) -> AppMap.Experiment? { experiments.first { $0.id == id } }

  func node(_ id: String) -> Node? { columns.joined().first { $0.id == id } }

  /// Where an experiment pushes, as a phrase per route: `at once · double submit`.
  func pushes(_ e: AppMap.Experiment, step: String? = nil) -> [String: String] {
    var out: [String: [String]] = [:]
    for p in e.pressure where step == nil || p.step == nil || p.step == step {
      for r in p.routes where !(out[Self.route(r)]?.contains(p.what) ?? false) { out[Self.route(r), default: []].append(p.what) }
    }
    return out.mapValues { $0.joined(separator: " · ") }
  }

  func highlight(_ e: AppMap.Experiment) -> Highlight {
    Highlight(lit: nodesOf[e.id] ?? [], pushed: pushes(e), broke: Self.brokeRule(outcomes[e.id]), blamed: blame(e), sent: sent(e.steps), flowing: true)
  }

  /// One step: its pages, the routes it called with the pages that send them, and what those changed.
  func highlight(_ e: AppMap.Experiment, step i: Int) -> Highlight {
    let step = e.steps[i]
    let went = nodesOf[e.id] ?? []
    var lit = Set(step.pages.map(Self.page))
    for c in step.calls {
      let id = Self.route(c.route)
      lit.insert(id)
      for edge in edges where went.contains(edge.from) && went.contains(edge.to) && (edge.to == id || edge.from == id) {
        lit.insert(edge.from)
        lit.insert(edge.to)
      }
    }
    let here = pushes(e, step: step.name).filter { lit.contains($0.key) }
    return Highlight(lit: lit, pushed: here, broke: Self.brokeRule(outcomes[e.id]), blamed: blame(e).intersection(lit), sent: sent([step]), flowing: true)
  }

  private func sent(_ steps: [AppMap.Step]) -> [String: Int] {
    var out: [String: Int] = [:]
    for s in steps { for c in s.calls { out[Self.route(c.route), default: 0] += c.count } }
    return out
  }

  /// A node and what it connects to.
  func highlight(node id: String) -> Highlight {
    var lit: Set = [id]
    for edge in edges where edge.from == id || edge.to == id {
      lit.insert(edge.from)
      lit.insert(edge.to)
    }
    return Highlight(lit: lit)
  }

  /// The line under a node's name, and its colour.
  func caption(_ node: Node, _ h: Highlight) -> (String, Color) {
    if let phrase = h.pushed[node.id] { return (phrase, h.broke && h.blamed.contains(node.id) ? Theme.fail : Theme.accent) }
    // Following an experiment: what it did here, not what all of them did.
    if let sent = h.sent, h.lit?.contains(node.id) == true {
      if node.kind == .route, let n = sent[node.id] { return (n == 1 ? "sent once" : "sent ×\(n)", Theme.faint) }
      if node.kind == .table { return ("changed", Theme.faint) }
    }
    let n = through[node.id]?.count ?? 0
    switch node.kind {
    case .page:
      let page = pages[String(node.id.dropFirst(2))]
      let name = page?.texts.first ?? page?.buttons.first ?? ""
      return n == 0 ? (name.isEmpty ? "Not visited" : "\(name) · not visited", Theme.ghost) : (name.isEmpty ? Fmt.plural(n, "experiment") : name, Theme.faint)
    case .layout:
      return ("around them: \(map.pages.first { Self.layout($0.path) == node.id }?.buttons.first ?? "the layout")", Theme.faint)
    case .outside:
      return ("from outside the app", Theme.faint)
    case .route:
      if broke.contains(node.id) {
        let b = (through[node.id] ?? []).filter { id in Self.brokeRule(outcomes[id]) && (experiment(id).map { blame($0).contains(node.id) } ?? false) }.count
        return ("\(b) broke a rule here", Theme.fail)
      }
      return n == 0 ? ("Not tested", Theme.ghost) : (Fmt.plural(n, "experiment"), Theme.faint)
    case .table:
      let name = String(node.id.dropFirst(2))
      if !map.routes.contains(where: { $0.writes.contains(name) }) { return ("read only", Theme.ghost) }
      return n == 0 ? ("Not changed", Theme.ghost) : ("changed in \(n)", Theme.faint)
    case .service:
      return ("outside the app", Theme.faint)
    }
  }

  /// The sentence a node's tooltip says.
  func help(_ node: Node) -> String {
    let n = through[node.id]?.count ?? 0
    let pushing = (through[node.id] ?? []).filter { experiment($0).map { pushes($0)[node.id] != nil } ?? false }
    let breaking = pushing.filter { id in Self.brokeRule(outcomes[id]) && (experiment(id).map { blame($0).contains(node.id) } ?? false) }
    switch node.kind {
    case .page, .layout:
      return n == 0 ? "No experiment opened this page yet." : "Opened by \(Fmt.plural(n, "experiment"))."
    case .outside:
      return "Requests from outside the app, like a payment provider's webhooks."
    case .route:
      if n == 0 { return "No experiment sent this request yet." }
      var s = "Sent by \(Fmt.plural(n, "experiment"))"
      if !pushing.isEmpty { s += "; \(pushing.count) push on it" }
      if !breaking.isEmpty { s += "; \(breaking.count) of those broke a rule" }
      return s + "."
    case .table:
      return n == 0 ? "No experiment's newest run changed this table." : "Changed by \(Fmt.plural(n, "experiment"))'s newest run."
    case .service:
      return "A call out of the app."
    }
  }
}

// MARK: - The picture

private nonisolated struct PortKey: PreferenceKey {
  static var defaultValue: [String: Anchor<CGRect>] { [:] }

  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue()) { $1 }
  }
}

/// Pages, routes and data in three columns, a line wherever one calls or writes the next. Lines an
/// experiment went along are solid, ones none did are dotted; red runs to where a rule broke.
private struct Diagram: View {
  let graph: MapGraph
  let highlight: MapGraph.Highlight
  let selected: String?
  @Binding var hover: MapHover?
  let onSelect: (String) -> Void

  private static let widths: [CGFloat] = [150, 190, 132]
  private static let titles = ["Pages", "Routes", "Data"]

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(0..<3, id: \.self) { c in
        // Pages to routes run mostly level; routes fan out to what they change, so that gap grows.
        if c == 1 { Spacer(minLength: 44).frame(maxWidth: 120) }
        if c == 2 { Spacer(minLength: 56) }
        VStack(alignment: c == 0 ? .trailing : .leading, spacing: 0) {
          Text(Self.titles[c]).label().padding(.bottom, 10)
          ForEach(graph.columns[c]) { node in
            if node.kind == .service, graph.columns[c].first(where: { $0.kind == .service }) == node {
              Text("Calls out").label(Theme.ghost).padding(.top, 14).padding(.bottom, 2)
            }
            NodeLabel(
              node: node, caption: graph.caption(node, highlight), trailing: c == 0,
              tested: graph.through[node.id] != nil,
              dim: highlight.lit.map { !$0.contains(node.id) } ?? false,
              selected: selected == node.id
            )
            .help(graph.help(node))
            .onHover { inside in
              if inside { hover = .node(node.id) } else if hover == .node(node.id) { hover = nil }
            }
            .onTapGesture { onSelect(node.id) }
          }
        }
        .frame(width: Self.widths[c], alignment: c == 0 ? .trailing : .leading)
      }
    }
    .backgroundPreferenceValue(PortKey.self) { ports in
      GeometryReader { geo in
        Wires(graph: graph, highlight: highlight, rects: ports.mapValues { geo[$0] })
      }
    }
    .animation(Theme.snappy, value: highlight.lit)
  }
}

private struct NodeLabel: View {
  let node: MapGraph.Node
  let caption: (String, Color)
  let trailing: Bool
  let tested: Bool
  let dim: Bool
  let selected: Bool

  var body: some View {
    VStack(alignment: trailing ? .trailing : .leading, spacing: 2) {
      name
        .lineLimit(1)
        .truncationMode(.middle)
        .anchorPreference(key: PortKey.self, value: .bounds) { [node.id: $0] }
      Text(caption.0).font(Theme.sans(11)).foregroundStyle(caption.1).lineLimit(1)
    }
    .padding(.vertical, 5)
    .padding(.horizontal, 6)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(selected ? Theme.selection : .clear))
    .padding(.horizontal, -6)
    .opacity(dim ? 0.3 : 1)
    .contentShape(Rectangle())
  }

  @ViewBuilder private var name: some View {
    let color = tested ? Theme.text : Theme.faint
    switch node.kind {
    case .layout, .outside:
      Text(node.name).font(Theme.sans(12, .medium)).foregroundStyle(color)
    case .route, .service:
      let parts = node.name.split(separator: " ", maxSplits: 1).map(String.init)
      if parts.count == 2 {
        Text("\(Text(parts[0]).foregroundStyle(Theme.faint)) \(Text(parts[1]).foregroundStyle(color))").font(Theme.mono(11, .medium))
      } else {
        Text(node.name).font(Theme.mono(11, .medium)).foregroundStyle(color)
      }
    case .page, .table:
      Text(node.name).font(Theme.mono(11, .medium)).foregroundStyle(color)
    }
  }
}

/// The lines and the dots where they meet the names, drawn behind them. While an experiment is in
/// view, requests move along its lines: page to route, then route to what it changed.
private struct Wires: View {
  let graph: MapGraph
  let highlight: MapGraph.Highlight
  let rects: [String: CGRect]
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.controlActiveState) private var active
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    ZStack {
      Canvas { context, _ in draw(&context) }
      // Only the moving requests redraw each frame; the lines under them hold still.
      if highlight.flowing && !reduceMotion {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: active == .inactive)) { timeline in
          let t = Dither.clock(timeline.date)
          Canvas { context, _ in requests(&context, t: t) }
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  /// Whether a line is lit (nil: nothing is), and whether it runs to where a rule broke.
  private func look(_ edge: MapGraph.Edge) -> (on: Bool?, red: Bool) {
    let on = highlight.lit.map { $0.contains(edge.from) && $0.contains(edge.to) }
    let red = on == true ? highlight.broke && (highlight.blamed.contains(edge.from) || highlight.blamed.contains(edge.to)) : on == nil && graph.brokeEdges.contains(edge)
    return (on, red)
  }

  /// A request on its way along each lit line: page to route first, then route to what it changed.
  private func requests(_ context: inout GraphicsContext, t: Double) {
    for edge in graph.edges {
      guard let a = rects[edge.from], let b = rects[edge.to] else { continue }
      let (on, red) = look(edge)
      guard on == true else { continue }
      let stage = edge.from.hasPrefix("r ") ? 1.0 : 0.0
      let local = t.truncatingRemainder(dividingBy: 2.6) - stage * 0.95
      guard local >= 0, local <= 1.25 else { continue }
      let u = local / 1.25
      let at = Curve(a, b).point(u * u * (3 - 2 * u))
      let alpha = sin(.pi * u)
      let ink = red ? Theme.fail : Theme.accentLight
      context.fill(Path(ellipseIn: CGRect(x: at.x - 5, y: at.y - 5, width: 10, height: 10)), with: .color(ink.opacity(0.16 * alpha)))
      context.fill(Path(ellipseIn: CGRect(x: at.x - 2.2, y: at.y - 2.2, width: 4.4, height: 4.4)), with: .color(ink.opacity(alpha)))
    }
  }

  private func draw(_ context: inout GraphicsContext) {
    let lit = highlight.lit
    let light = scheme == .light
    for edge in graph.edges {
      guard let a = rects[edge.from], let b = rects[edge.to] else { continue }
      let curve = Curve(a, b)
      let tested = graph.testedEdges.contains(edge)
      var path = Path()
      path.move(to: curve.p0)
      path.addCurve(to: curve.p3, control1: curve.p1, control2: curve.p2)
      let (on, red) = look(edge)
      let color: Color
      let width: CGFloat
      switch on {
      case true?:
        color = red ? Theme.fail.opacity(0.9) : Theme.accent.opacity(light ? 0.8 : 0.75)
        width = 1.5
      case false?:
        color = Theme.overlay(light ? 0.07 : 0.06)
        width = 1
      case nil:
        color = red ? Theme.fail.opacity(0.55) : tested ? Theme.accent.opacity(light ? 0.42 : 0.34) : Theme.overlay(0.16)
        width = red ? 1.25 : 1
      }
      context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, dash: tested || on == true ? [] : [1.5, 3.5]))
    }

    // A dot where each name meets its lines: filled where an experiment went, red where a rule broke.
    for (c, column) in graph.columns.enumerated() {
      for node in column {
        guard let r = rects[node.id] else { continue }
        let tested = graph.through[node.id] != nil
        let dim = lit.map { !$0.contains(node.id) } ?? false
        let red = lit == nil ? graph.broke.contains(node.id) : highlight.broke && highlight.blamed.contains(node.id)
        let outgoing = graph.edges.contains { $0.from == node.id }
        var sides: [CGFloat] = []
        if c == 0 || (c == 1 && outgoing) { sides.append(r.maxX + Curve.gap) }
        if c > 0 { sides.append(r.minX - Curve.gap) }
        for x in sides {
          let dot = CGRect(x: x - 2.5, y: r.midY - 2.5, width: 5, height: 5)
          let ink = red ? Theme.fail : Theme.accent
          if tested {
            context.fill(Path(ellipseIn: dot), with: .color(ink.opacity(dim ? 0.25 : 1)))
          } else {
            context.stroke(Path(ellipseIn: dot.insetBy(dx: 0.5, dy: 0.5)), with: .color(Theme.ghost.opacity(dim ? 0.5 : 1)), lineWidth: 1)
          }
        }
      }
    }
  }
}

/// From the right of one name to the left of the next, leaving and arriving level.
private struct Curve {
  static let gap: CGFloat = 8
  let p0, p1, p2, p3: CGPoint

  init(_ a: CGRect, _ b: CGRect) {
    p0 = CGPoint(x: a.maxX + Self.gap, y: a.midY)
    p3 = CGPoint(x: b.minX - Self.gap, y: b.midY)
    let dx = max(20, (p3.x - p0.x) * 0.5)
    p1 = CGPoint(x: p0.x + dx, y: p0.y)
    p2 = CGPoint(x: p3.x - dx, y: p3.y)
  }

  func point(_ u: Double) -> CGPoint {
    let v = 1 - u
    let a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u
    return CGPoint(x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y)
  }
}

// MARK: - Above

/// How much of the app the experiments reach: routes sent, pages opened, where rules broke, and
/// what nothing has touched yet.
private struct MapHero: View {
  let graph: MapGraph

  var body: some View {
    let routes = graph.columns[1]
    let tested = routes.filter { graph.through[$0.id] != nil }
    let broke = routes.filter { graph.broke.contains($0.id) }
    let pages = graph.columns[0].filter { $0.kind == .page }
    let opened = pages.filter { graph.through[$0.id] != nil }
    HStack(alignment: .center, spacing: 48) {
      VStack(alignment: .leading, spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Text("\(tested.count)").font(Theme.figure(56)).foregroundStyle(Theme.text)
          Text("of \(Fmt.plural(routes.count, "route")) tested").font(Theme.sans(15)).foregroundStyle(Theme.faint)
        }
        SplitBar(parts: [(tested.count - broke.count, Theme.accent), (broke.count, Theme.fail), (routes.count - tested.count, Theme.overlay(0.12))])
          .frame(width: 340)
          .padding(.top, 14)
        Text(summary(pages: pages.count, opened: opened.count, broke: broke, untested: routes.filter { graph.through[$0.id] == nil }))
          .font(Theme.sans(12)).foregroundStyle(Theme.faint)
          .lineLimit(2)
          .padding(.top, 12)
      }
      .layoutPriority(1)
      Spacer(minLength: 0)
      VStack(alignment: .leading, spacing: 7) {
        LegendKey(text: "An experiment went here") { Circle().fill(Theme.accent).frame(width: 5, height: 5) }
        LegendKey(text: "A rule broke here") { Circle().fill(Theme.fail).frame(width: 5, height: 5) }
        LegendKey(text: "Nothing has yet") { Circle().strokeBorder(Theme.ghost, lineWidth: 1).frame(width: 5, height: 5) }
        LegendKey(text: "Calls or writes") {
          Path { $0.move(to: CGPoint(x: 0, y: 0.5)); $0.addLine(to: CGPoint(x: 14, y: 0.5)) }
            .stroke(Theme.accent.opacity(0.6), lineWidth: 1).frame(width: 14, height: 1)
        }
      }
    }
  }

  private func summary(pages: Int, opened: Int, broke: [MapGraph.Node], untested: [MapGraph.Node]) -> String {
    var parts = ["\(opened) of \(Fmt.plural(pages, "page")) opened"]
    if !broke.isEmpty { parts.append("rules broke at \(broke.map(\.name).joined(separator: ", "))") }
    if !untested.isEmpty {
      let names = untested.prefix(2).map(\.name).joined(separator: ", ")
      parts.append("never sent: \(names)\(untested.count > 2 ? " and \(untested.count - 2) more" : "")")
    }
    return parts.joined(separator: "  ·  ")
  }
}

private struct LegendKey<Mark: View>: View {
  let text: String
  @ViewBuilder var mark: () -> Mark

  var body: some View {
    HStack(spacing: 8) {
      mark().frame(width: 14)
      Text(text).font(Theme.sans(11)).foregroundStyle(Theme.faint)
    }
  }
}

// MARK: - Beside

/// The experiments, or the one being followed, or what's behind the node chosen.
private struct Inspector: View {
  let graph: MapGraph
  @Binding var focus: MapFocus
  @Binding var hover: MapHover?

  var body: some View {
    Group {
      switch focus {
      case .app:
        ExperimentList(graph: graph, focus: $focus, hover: $hover)
      case .experiment(let id):
        if let e = graph.experiment(id) { ExperimentWalk(graph: graph, experiment: e, focus: $focus, hover: $hover) }
      case .node(let id):
        if let node = graph.node(id) { NodeDetail(graph: graph, node: node, focus: $focus, hover: $hover) }
      }
    }
    .id(focus)
    .transition(.opacity.combined(with: .offset(x: -6)))
    .onChange(of: focus) { hover = nil }
  }
}

private struct ExperimentList: View {
  let graph: MapGraph
  @Binding var focus: MapFocus
  @Binding var hover: MapHover?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text("Experiments").font(Theme.sans(13, .semibold)).foregroundStyle(Theme.text)
        Spacer()
        Text("\(graph.experiments.count)").font(Theme.sans(12)).monospacedDigit().foregroundStyle(Theme.faint)
      }
      Text("Point at one to see its way through the app. Click to follow it step by step.")
        .font(Theme.sans(12)).foregroundStyle(Theme.faint).lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 6)
        .padding(.bottom, 12)
      if graph.experiments.isEmpty {
        Text("None yet. Your agent writes them during /windtunnel:init and hunts.").font(Theme.sans(12)).foregroundStyle(Theme.ghost)
      }
      ForEach(graph.experiments) { e in
        ExperimentRow(experiment: e, outcome: graph.outcomes[e.id], note: nil, hover: $hover) {
          withAnimation(Theme.snappy) { focus = .experiment(e.id) }
        }
      }
    }
  }
}

/// An experiment as a row: its outcome and name, and a note on the right.
private struct ExperimentRow: View {
  let experiment: AppMap.Experiment
  let outcome: String?
  let note: (String, Color)?
  @Binding var hover: MapHover?
  let open: () -> Void
  @State private var hovering = false

  var body: some View {
    HStack(spacing: 10) {
      if let outcome {
        Circle().fill(Tone(outcome).color).frame(width: 6, height: 6)
      } else {
        Circle().strokeBorder(Theme.ghost, lineWidth: 1).frame(width: 6, height: 6)
      }
      Text(experiment.id).font(Theme.sans(12)).foregroundStyle(hovering ? Theme.text : Theme.text.opacity(0.86)).lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 6)
      if let note { Text(note.0).font(Theme.sans(11)).foregroundStyle(note.1).lineLimit(1) }
    }
    .padding(.horizontal, 8)
    .frame(height: 28)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(hovering ? Theme.hover : .clear))
    .padding(.horizontal, -8)
    .contentShape(Rectangle())
    .onHover { inside in
      hovering = inside
      if inside { hover = .experiment(experiment.id) } else if hover == .experiment(experiment.id) { hover = nil }
    }
    .onTapGesture(perform: open)
    .help(experiment.description ?? experiment.id)
  }
}

/// One experiment, step by step, as its newest run went: the pages each step opened and the
/// requests it sent, and where it pushed.
private struct ExperimentWalk: View {
  let graph: MapGraph
  let experiment: AppMap.Experiment
  @Binding var focus: MapFocus
  @Binding var hover: MapHover?
  @Environment(AppModel.self) private var model

  var body: some View {
    let outcome = graph.outcomes[experiment.id]
    let broke = MapGraph.brokeRule(outcome)
    VStack(alignment: .leading, spacing: 0) {
      BackLink(focus: $focus)
      Text(experiment.id).font(Theme.sans(15, .semibold)).foregroundStyle(Theme.text).padding(.top, 14)
      HStack(spacing: 8) {
        OutcomeBadge(outcome: outcome ?? "not run")
        if let broken = experiment.run?.broken, !broken.isEmpty {
          Text(broken.joined(separator: ", ")).font(Theme.mono(11)).foregroundStyle(Theme.fail).lineLimit(1).truncationMode(.middle)
        }
      }
      .padding(.top, 6)
      if let d = experiment.description {
        Text(d).font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true).padding(.top, 10)
      }
      if !experiment.pressure.isEmpty || !experiment.users.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          if !experiment.pressure.isEmpty {
            Fact(label: "Pushes", value: experiment.pressure.map(\.what).joined(separator: " · "), color: broke ? Theme.fail : Theme.accent)
          }
          if !experiment.users.isEmpty { Fact(label: "As", value: experiment.users.joined(separator: ", ")) }
        }
        .padding(.top, 12)
      }
      Hairline().padding(.vertical, 18)
      HStack(alignment: .firstTextBaseline) {
        Text("Steps").label()
        Spacer()
        if let run = experiment.run {
          Button("Open run") {
            model.selectedRun = run.id
            model.section = .runs
          }
          .buttonStyle(LinkButtonStyle())
        }
      }
      if let run = experiment.run {
        Text("Repetition \(run.rep) of \(run.reps), \(Fmt.ago(ISO.date(run.startedAt)))").font(Theme.sans(11)).foregroundStyle(Theme.ghost).padding(.top, 3)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(experiment.steps.enumerated()), id: \.offset) { i, step in
            StepRow(index: i, step: step, tags: graph.pushes(experiment, step: step.name), blamed: broke ? graph.blame(experiment) : [], lit: hover == .step(i))
              .onHover { inside in
                if inside { hover = .step(i) } else if hover == .step(i) { hover = nil }
              }
          }
        }
        .padding(.top, 10)
        .padding(.horizontal, -8)
      } else {
        Text("Not run yet. Run it to see the way it goes through the app.").font(Theme.sans(12)).foregroundStyle(Theme.faint).padding(.top, 6)
        Button {
          model.runExperiments([experiment.id])
        } label: {
          Label("Run", systemImage: "play.fill")
        }
        .buttonStyle(ActionButtonStyle())
        .disabled(model.runningJob != nil)
        .padding(.top, 12)
      }
    }
  }
}

private struct StepRow: View {
  let index: Int
  let step: AppMap.Step
  /// What the experiment does at this step, per route.
  let tags: [String: String]
  /// Routes the broken rule is put down to.
  let blamed: Set<String>
  let lit: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text("\(index + 1)").font(Theme.mono(10)).foregroundStyle(Theme.ghost).frame(width: 14, alignment: .trailing)
      VStack(alignment: .leading, spacing: 4) {
        Text(step.name).font(Theme.sans(12, .medium)).foregroundStyle(Theme.text)
        ForEach(step.pages, id: \.self) { page in
          HStack(spacing: 6) {
            Image(systemName: "macwindow").font(.system(size: 9)).foregroundStyle(Theme.ghost)
            Text(page).font(Theme.mono(11)).foregroundStyle(Theme.dim).lineLimit(1).truncationMode(.middle)
          }
        }
        ForEach(step.calls, id: \.route) { call in
          CallLine(call: call, tag: tags[MapGraph.route(call.route)], broke: blamed.contains(MapGraph.route(call.route)))
        }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 7)
    .padding(.horizontal, 8)
    .background(RoundedRectangle(cornerRadius: Theme.controlRadius, style: .continuous).fill(lit ? Theme.hover : .clear))
    .contentShape(Rectangle())
  }
}

/// A request a step sent: how many, and whether two were in the app at once.
private struct CallLine: View {
  let call: AppMap.Call
  let tag: String?
  let broke: Bool

  var body: some View {
    let words = [call.together && !(tag ?? "").contains("at once") ? "at once" : nil, tag].compactMap { $0 }.joined(separator: " · ")
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Image(systemName: "arrow.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.ghost)
        Text(call.route).font(Theme.mono(11)).foregroundStyle(Theme.text.opacity(0.86)).lineLimit(1).truncationMode(.middle)
        if call.count > 1 { Text("×\(call.count)").font(Theme.mono(10)).foregroundStyle(Theme.faint).fixedSize() }
      }
      if !words.isEmpty {
        Text(words).font(Theme.sans(11, .medium)).foregroundStyle(tag != nil && broke ? Theme.fail : Theme.accent).padding(.leading, 14)
      }
    }
    .help(help)
  }

  private var help: String {
    var s = "Sent \(call.count == 1 ? "once" : "\(call.count) times")"
    if call.tabs > 1 { s += " from \(call.tabs) tabs" }
    if call.together { s += ", two of them in the app at the same time" }
    if call.failed > 0 { s += "; \(call.failed) answered with an error" }
    return s + "."
  }
}

/// What's behind one node: what a route does, what a page shows, who writes a table, and the
/// experiments that went through it.
private struct NodeDetail: View {
  let graph: MapGraph
  let node: MapGraph.Node
  @Binding var focus: MapFocus
  @Binding var hover: MapHover?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      BackLink(focus: $focus)
      Text(node.name).font(node.kind == .layout || node.kind == .outside ? Theme.sans(15, .semibold) : Theme.mono(13, .medium))
        .foregroundStyle(Theme.text).lineLimit(2).padding(.top, 14)
      switch node.kind {
      case .route: if let r = graph.routes[String(node.id.dropFirst(2))] { route(r) }
      case .page, .layout: if let p = graph.map.pages.first(where: { MapGraph.page($0.path) == node.id || MapGraph.layout($0.path) == node.id }) { page(p) }
      case .table: table(String(node.id.dropFirst(2)))
      case .service:
        Text("A call out of the app").font(Theme.sans(12)).foregroundStyle(Theme.faint).padding(.top, 4)
        Links(title: "Called by", ids: graph.map.routes.filter { $0.services.contains(node.name) }.map(\.key), focus: $focus)
      case .outside:
        Text("Requests sent to the app from outside it, like a payment provider's webhooks.").font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true).padding(.top, 8)
        Links(title: "Sent to", ids: graph.map.routes.filter(\.webhook).map(\.key), focus: $focus)
      }
      Went(graph: graph, node: node, focus: $focus, hover: $hover)
    }
  }

  @ViewBuilder private func route(_ r: AppMap.Route) -> some View {
    Text(r.file).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle).padding(.top, 4)
    if let c = r.comment {
      Text(c).font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true).padding(.top, 10)
    }
    if !r.effects.isEmpty {
      InfoSection(title: "What it does, in order") {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(r.effects.enumerated()), id: \.offset) { i, e in
            EffectRow(effect: e, opensTx: e.tx && (i == 0 || !r.effects[i - 1].tx))
          }
        }
      }
    }
    if !r.flags.isEmpty || !r.notes.isEmpty {
      InfoSection(title: "Worth a look") {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(r.flags, id: \.self) { Mark(glyph: "!", text: $0, color: Theme.flaky) }
          ForEach(r.notes, id: \.self) { Mark(glyph: "✓", text: $0, color: Theme.accent) }
        }
      }
    }
  }

  @ViewBuilder private func page(_ p: AppMap.Page) -> some View {
    Text(p.file + (p.login ? "  ·  login required" : "")).font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.middle).padding(.top, 4)
    if !(p.texts.isEmpty && p.buttons.isEmpty && p.fields.isEmpty) {
      InfoSection(title: "On the page") {
        VStack(alignment: .leading, spacing: 5) {
          if !p.texts.isEmpty { Fact(label: "Shows", value: p.texts.prefix(5).map { "“\($0)”" }.joined(separator: ", ")) }
          if !p.buttons.isEmpty { Fact(label: "Buttons", value: p.buttons.joined(separator: ", ")) }
          if !p.fields.isEmpty { Fact(label: "Fields", value: p.fields.joined(separator: ", ")) }
        }
      }
    }
    if !p.calls.isEmpty { Links(title: "Sends", ids: p.calls, focus: $focus) }
    if !p.visits.isEmpty {
      InfoSection(title: graph.map.crawl?.stale == true ? "Live crawl, before the code changed" : "Live crawl") {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(p.visits, id: \.self) { v in
            HStack(spacing: 8) {
              Text(v.as).font(Theme.sans(12)).foregroundStyle(Theme.dim).frame(width: 72, alignment: .leading)
              Text(v.final.map { "→ \($0.split(separator: "?").first.map(String.init) ?? $0)" } ?? "\(v.status)")
                .font(Theme.mono(11)).foregroundStyle(v.status >= 400 ? Theme.fail : Theme.faint)
            }
          }
        }
      }
    }
  }

  @ViewBuilder private func table(_ name: String) -> some View {
    Text("table").font(Theme.sans(12)).foregroundStyle(Theme.faint).padding(.top, 4)
    let writers = graph.map.routes.filter { $0.writes.contains(name) }.map(\.key)
    let readers = graph.map.routes.filter { $0.reads.contains(name) }.map(\.key)
    if !writers.isEmpty { Links(title: "Written by", ids: writers, focus: $focus) }
    if !readers.isEmpty { Links(title: "Read by", ids: readers, focus: $focus) }
  }
}

/// The experiments that went through a node, with what each does there.
private struct Went: View {
  let graph: MapGraph
  let node: MapGraph.Node
  @Binding var focus: MapFocus
  @Binding var hover: MapHover?

  var body: some View {
    let ids = graph.through[node.id] ?? []
    InfoSection(title: ids.isEmpty ? "Not tested yet" : "\(Fmt.plural(ids.count, "experiment")) went through") {
      if ids.isEmpty {
        Text(node.kind == .route ? "No experiment sends this request yet. A hunt can write one." : "No experiment has gone here yet.")
          .font(Theme.sans(12)).foregroundStyle(Theme.faint).fixedSize(horizontal: false, vertical: true)
      } else {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(ids.compactMap(graph.experiment), id: \.id) { e in
            let push = graph.pushes(e)[node.id]
            let red = MapGraph.brokeRule(graph.outcomes[e.id]) && graph.blame(e).contains(node.id)
            ExperimentRow(experiment: e, outcome: graph.outcomes[e.id], note: push.map { ($0, red ? Theme.fail : Theme.accent) }, hover: $hover) {
              withAnimation(Theme.snappy) { focus = .experiment(e.id) }
            }
          }
        }
      }
    }
  }
}

private struct EffectRow: View {
  let effect: AppMap.Route.Effect
  /// The first step of a transaction: says so above it.
  let opensTx: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      if opensTx { Text("in one transaction").font(Theme.sans(11)).foregroundStyle(Theme.ghost).padding(.top, 4) }
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(word).font(Theme.sans(11, .medium)).foregroundStyle(color).frame(width: 34, alignment: .leading)
        Text(effect.text).font(Theme.mono(11)).foregroundStyle(effect.kind == "write" ? Theme.text.opacity(0.86) : Theme.dim)
          .lineLimit(3).fixedSize(horizontal: false, vertical: true)
          .help(effect.text)
      }
      .padding(.vertical, 3)
    }
    .padding(.leading, effect.tx ? 10 : 0)
    .overlay(alignment: .leading) {
      if effect.tx { Rectangle().fill(Theme.accent.opacity(0.35)).frame(width: 1.5).padding(.top, opensTx ? 20 : 0) }
    }
  }

  private var word: String {
    switch effect.kind {
    case "auth": "auth"
    case "read": "reads"
    case "write": "writes"
    default: "calls"
    }
  }

  private var color: Color {
    switch effect.kind {
    case "write": Theme.text.opacity(0.86)
    case "call": Theme.accent
    default: Theme.faint
    }
  }
}

// MARK: - Small pieces

private struct BackLink: View {
  @Binding var focus: MapFocus

  var body: some View {
    Button {
      withAnimation(Theme.snappy) { focus = .app }
    } label: {
      Label("All experiments", systemImage: "chevron.left")
    }
    .buttonStyle(LinkButtonStyle())
  }
}

private struct InfoSection<Content: View>: View {
  let title: String
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title).label()
      content()
    }
    .padding(.top, 20)
  }
}

/// `Shows   “Cart”, “Total:…”`
private struct Fact: View {
  let label: String
  let value: String
  var color: Color = Theme.dim

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label).font(Theme.sans(11)).foregroundStyle(Theme.faint).frame(width: 52, alignment: .leading)
      Text(value).font(Theme.sans(12)).foregroundStyle(color).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct Mark: View {
  let glyph: String
  let text: String
  let color: Color

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(glyph).font(Theme.mono(11, .bold)).foregroundStyle(color).frame(width: 10)
      Text(text).font(Theme.sans(12)).foregroundStyle(Theme.dim).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
    }
  }
}

/// Routes as links: each opens what's behind it.
private struct Links: View {
  let title: String
  let ids: [String]
  @Binding var focus: MapFocus

  var body: some View {
    InfoSection(title: title) {
      VStack(alignment: .leading, spacing: 4) {
        ForEach(ids, id: \.self) { key in
          Button {
            withAnimation(Theme.snappy) { focus = .node(MapGraph.route(key)) }
          } label: {
            Text(key).font(Theme.mono(11)).lineLimit(1).truncationMode(.middle)
          }
          .buttonStyle(LinkButtonStyle(color: Theme.dim))
        }
      }
    }
  }
}

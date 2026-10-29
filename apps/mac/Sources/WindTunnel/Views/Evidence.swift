import SwiftUI

// MARK: - Trace chain

/// Per table, every statement that touched it in order, with the connection, the transaction,
/// and who caused it (which tab's request, which webhook, which handler line).
struct TraceTab: View {
  let rep: RepView?

  var body: some View {
    if let trace = rep?.trace {
      VStack(alignment: .leading, spacing: 30) {
        ForEach(Array(trace.tables.enumerated()), id: \.element.table) { index, table in
          let focus = rep?.rules.contains { !$0.ok } == true && trace.focus.contains(table.table)
          Panel(table.table, tint: focus ? Theme.fail : nil, mono: true, rule: index > 0, accessory: {
            Text(table.change ?? "").foregroundStyle(focus ? Theme.fail : Theme.faint)
          }) {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(Array(table.events.enumerated()), id: \.offset) { i, e in
                ChainEventRow(event: e, last: i == table.events.count - 1)
              }
              if let more = table.more, more > 0 {
                Text("\(more) more").font(Theme.sans(11)).foregroundStyle(Theme.faint)
              }
            }
          }
        }
        if let more = trace.more, !more.isEmpty {
          Text("Also changed: " + more.joined(separator: ", ")).font(Theme.sans(12)).foregroundStyle(Theme.faint)
        }
      }
    } else {
      EmptyBlock(text: rep == nil ? "Loading…" : "No SQL log for this run.")
    }
  }
}

private struct ChainEventRow: View {
  let event: ChainEvent
  let last: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Text("+\(Fmt.ms(event.at))").font(Theme.mono(10)).foregroundStyle(Theme.faint).frame(width: 62, alignment: .trailing)
      VStack(spacing: 0) {
        Circle().fill(dotColor).frame(width: 6, height: 6).padding(.top, 5)
        if !last { Rectangle().fill(Theme.line).frame(width: 1).frame(maxHeight: .infinity) }
      }
      .frame(width: 8)
      VStack(alignment: .leading, spacing: 5) {
        if event.kind == "sql", let sql = event.sql {
          HStack(spacing: 10) {
            if let conn = event.conn {
              Text("connection \(conn)").foregroundStyle(Theme.dim)
            }
            if event.tx == true { Text("in transaction").foregroundStyle(Theme.faint) }
            Text(event.result ?? "").foregroundStyle(event.error != nil ? Theme.fail : Theme.faint)
            if let ms = event.ms { Text("\(Int(ms)) ms").foregroundStyle(Theme.ghost) }
          }
          .font(Theme.sans(11))
          Text(SQL.highlight(sql.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)))
            .font(Theme.mono(11)).textSelection(.enabled).lineLimit(4)
          if let params = event.params, !params.isEmpty {
            Text("params " + params.enumerated().map { "$\($0.offset + 1)=\($0.element ?? "null")" }.joined(separator: "  "))
              .font(Theme.mono(11)).foregroundStyle(Theme.faint).lineLimit(1)
          }
          ForEach(Array((event.sources ?? []).enumerated()), id: \.offset) { _, s in
            HStack(spacing: 6) {
              Text("from").foregroundStyle(Theme.ghost)
              if let who = s.who, !who.isEmpty { Text(who.joined(separator: ", ")).foregroundStyle(Theme.dim) }
              if let what = s.what { Text(what).foregroundStyle(Theme.dim) }
              if let h = s.handler { Text("\(h)\(s.lines.map { ":" + $0.joined(separator: ",") } ?? "")").foregroundStyle(Theme.accent.opacity(0.85)) }
            }
            .font(Theme.mono(11))
          }
        } else {
          Text(event.text ?? "").font(Theme.sans(12)).italic().foregroundStyle(Theme.dim)
        }
      }
      Spacer(minLength: 0)
    }
  }

  private var dotColor: Color {
    if event.error != nil { return Theme.fail }
    if event.kind != "sql" { return Theme.dim }
    let s = event.sql?.uppercased() ?? ""
    return s.hasPrefix("SELECT") ? Theme.ghost : Theme.accent
  }
}

// MARK: - Database

struct DatabaseTab: View {
  let rep: RepView?

  var body: some View {
    if let diff = rep?.diff, !diff.tables.isEmpty {
      VStack(alignment: .leading, spacing: 30) {
        ForEach(Array(diff.tables.keys.sorted().enumerated()), id: \.element) { index, name in
          let t = diff.tables[name]!
          Panel(name, mono: true, rule: index > 0, accessory: {
            Text([t.added.isEmpty ? nil : "\(t.added.count) added", t.removed.isEmpty ? nil : "\(t.removed.count) removed", t.changed.isEmpty ? nil : "\(t.changed.count) changed"].compactMap { $0 }.joined(separator: ", "))
          }) {
            VStack(alignment: .leading, spacing: 10) {
              let rows = t.added.prefix(20).map { ("+", $0) } + t.removed.prefix(20).map { ("−", $0) }
              if let first = rows.first {
                ScrollView(.horizontal, showsIndicators: false) {
                  Grid(alignment: .leading, horizontalSpacing: 22, verticalSpacing: 6) {
                    GridRow {
                      Text("")
                      ForEach(first.1.fields, id: \.0) { k, _ in Text(k).foregroundStyle(Theme.faint) }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                      GridRow {
                        Text(r.0).foregroundStyle(r.0 == "+" ? Theme.accent : Theme.fail)
                        ForEach(r.1.fields, id: \.0) { _, v in
                          Text(Short.value(v, max: 32)).foregroundStyle(Theme.text.opacity(0.9)).lineLimit(1)
                        }
                      }
                    }
                  }
                  .font(Theme.mono(11))
                }
              }
              ForEach(Array(t.changed.prefix(20).enumerated()), id: \.offset) { _, c in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text("~").foregroundStyle(Theme.dim).frame(width: 10)
                  Text(Short.value(c.key)).foregroundStyle(Theme.faint)
                  ForEach(c.changes.keys.sorted(), id: \.self) { field in
                    let pair = c.changes[field]!
                    if case .array(let v) = pair, v.count == 2 {
                      HStack(spacing: 4) {
                        Text(field).foregroundStyle(Theme.dim)
                        Text(Short.value(v[0])).foregroundStyle(Theme.faint).strikethrough(color: Theme.faint)
                        Text("→").foregroundStyle(Theme.ghost)
                        Text(Short.value(v[1])).foregroundStyle(Theme.text)
                      }
                    } else {
                      Text("\(field) \(Short.value(pair))").foregroundStyle(Theme.dim)
                    }
                  }
                }
                .font(Theme.mono(11))
              }
            }
          }
        }
      }
    } else {
      EmptyBlock(text: rep == nil ? "Loading…" : "The database didn't change.")
    }
  }
}

// MARK: - Network

struct NetworkTab: View {
  let rep: RepView?
  @State private var all = false

  var body: some View {
    if let rep {
      let requests = rep.requests.filter { all || $0.notable }
      Panel("Requests", rule: false, accessory: {
        Toggle(isOn: $all.animation(Theme.spring)) {
          Text("Page loads").font(Theme.sans(11)).foregroundStyle(Theme.faint)
        }
        .toggleStyle(.checkbox)
        .controlSize(.mini)
      }) {
        Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 7) {
          GridRow {
            ForEach(["#", "At", "Tab", "Request", "Status", "Time", "SQL", "Handler"], id: \.self) { Text($0).label() }
          }
          GridRow { Hairline().gridCellColumns(8) }
          ForEach(requests) { r in
            GridRow {
              Text("\(r.id)").foregroundStyle(Theme.ghost)
              Text(Fmt.ms(r.start)).foregroundStyle(Theme.faint)
              Text(r.tab ?? "–").foregroundStyle(Theme.dim)
              HStack(spacing: 5) {
                Text(r.method).foregroundStyle(r.method == "GET" ? Theme.faint : Theme.accent)
                Text(r.path).foregroundStyle(Theme.text).fixedSize()
              }
              Text(r.status.map(String.init) ?? (r.failure ?? "–"))
                .foregroundStyle((r.status ?? 0) >= 400 ? Theme.fail : r.failure != nil ? Theme.flaky : Theme.dim)
                .lineLimit(1)
              Text(Fmt.ms((r.end ?? r.start) - r.start)).foregroundStyle(Theme.faint)
              Text(r.sql.map { "\($0.total)\($0.writes > 0 ? ", \($0.writes) writes" : "")" } ?? "").foregroundStyle((r.sql?.writes ?? 0) > 0 ? Theme.dim : Theme.faint)
              Text(r.handler ?? "").foregroundStyle(Theme.faint).lineLimit(1).truncationMode(.head)
            }
            .font(Theme.mono(11))
          }
        }
      }
    } else {
      EmptyBlock(text: "Loading…")
    }
  }
}

// MARK: - Log

struct LogTab: View {
  let rep: RepView?

  var body: some View {
    if let rep {
      let console = rep.console ?? [], errors = rep.errors ?? []
      VStack(alignment: .leading, spacing: 30) {
        if !console.isEmpty {
          TerminalPanel(title: "Browser console", lines: console.map { Short.value($0, max: 400) }, rule: false)
        }
        if !errors.isEmpty {
          TerminalPanel(title: "Errors", lines: errors.map { Short.value($0, max: 400) }, tint: Theme.fail, rule: !console.isEmpty)
        }
        TerminalPanel(title: "App log", lines: rep.log, rule: !console.isEmpty || !errors.isEmpty)
        if let traces = rep.traces, !traces.isEmpty {
          Panel("Playwright traces", accessory: { Text("npx playwright show-trace <file>").font(Theme.mono(11)) }) {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(traces, id: \.self) { t in
                Text(Fmt.tilde(t)).font(Theme.mono(11)).foregroundStyle(Theme.dim).textSelection(.enabled)
              }
            }
          }
        }
      }
    } else {
      EmptyBlock(text: "Loading…")
    }
  }
}

/// Lines in a terminal window, with a prompt-coloured gutter.
struct TerminalPanel: View {
  let title: String
  let lines: [String]
  var tint: Color? = nil
  var follow = false
  var rule = true

  var body: some View {
    Panel(title, tint: tint, rule: rule, accessory: { Text(Fmt.plural(lines.count, "line")) }) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
              HStack(alignment: .top, spacing: 10) {
                Text("\(i + 1)").foregroundStyle(Theme.ghost).frame(width: 30, alignment: .trailing)
                Text(color(line)).textSelection(.enabled)
              }
              .font(Theme.mono(11))
              .id(i)
            }
          }
          .padding(14)
        }
        .frame(maxHeight: 380)
        .background(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.well))
        .onChange(of: lines.count) {
          if follow { withAnimation { proxy.scrollTo(lines.count - 1, anchor: .bottom) } }
        }
      }
    }
  }

  private func color(_ line: String) -> AttributedString {
    var a = AttributedString(line)
    let lower = line.lowercased()
    a.foregroundColor =
      lower.contains("error") || lower.contains("✗") || lower.contains("fail") ? Theme.fail.opacity(0.9)
      : lower.contains("warn") ? Theme.flaky
      : line.hasPrefix("$") || line.hasPrefix("›") ? Theme.accent
      : Theme.dim
    return a
  }
}

struct EmptyBlock: View {
  let text: String

  var body: some View {
    Text(text)
      .font(Theme.sans(12))
      .foregroundStyle(Theme.faint)
      .padding(.vertical, 20)
  }
}

// MARK: - SQL

enum SQL {
  private static let keywords: Set<String> = [
    "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "RETURNING", "GROUP", "BY", "HAVING",
    "ORDER", "LIMIT", "AND", "OR", "NOT", "NULL", "AS", "DISTINCT", "COUNT", "SUM", "JOIN", "LEFT", "INNER", "ON", "IN",
    "IS", "BEGIN", "COMMIT", "ROLLBACK", "FOR", "CONFLICT", "DO", "NOTHING", "EXISTS", "CASE", "WHEN", "THEN", "ELSE", "END",
    "NOW", "COALESCE", "WITH", "DESC", "ASC", "LOCK", "SHARE", "SKIP", "LOCKED", "OFFSET", "UNION", "ALL",
  ]

  static func highlight(_ sql: String) -> AttributedString {
    var out = AttributedString()
    let pattern = #"('[^']*')|(\$\d+)|(\b\d+\b)|([A-Za-z_][A-Za-z_0-9]*)|(\s+)|(.)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return AttributedString(sql) }
    let ns = sql as NSString
    for m in regex.matches(in: sql, range: NSRange(location: 0, length: ns.length)) {
      let token = ns.substring(with: m.range)
      var piece = AttributedString(token)
      if m.range(at: 1).location != NSNotFound {
        piece.foregroundColor = Theme.accentLight
      } else if m.range(at: 2).location != NSNotFound {
        piece.foregroundColor = Theme.dim
      } else if m.range(at: 3).location != NSNotFound {
        piece.foregroundColor = Theme.accentLight
      } else if m.range(at: 4).location != NSNotFound {
        piece.foregroundColor = keywords.contains(token.uppercased()) ? Theme.accent : Theme.text.opacity(0.9)
      } else {
        piece.foregroundColor = Theme.dim
      }
      out += piece
    }
    return out
  }
}

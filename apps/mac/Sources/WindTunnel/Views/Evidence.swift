import SwiftUI

// MARK: - Trace chain

/// Per table, every statement that touched it in order, with the connection, the transaction,
/// and who caused it (which tab's request, which webhook, which handler line).
struct TraceTab: View {
  let rep: RepView?

  var body: some View {
    if let trace = rep?.trace {
      VStack(alignment: .leading, spacing: 16) {
        ForEach(trace.tables, id: \.table) { table in
          let focus = rep?.rules.contains { !$0.ok } == true && trace.focus.contains(table.table)
          Panel(table.table, tint: focus ? Theme.fail : nil, mono: true, accessory: {
            Text(table.change ?? "").foregroundStyle(focus ? Theme.fail : Theme.faint)
          }) {
            VStack(alignment: .leading, spacing: 10) {
              ForEach(Array(table.events.enumerated()), id: \.offset) { i, e in
                ChainEventRow(event: e, last: i == table.events.count - 1)
              }
              if let more = table.more, more > 0 {
                Text("\(more) more").font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
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
        Circle().fill(dotColor).frame(width: 7, height: 7).padding(.top, 4)
        if !last { Rectangle().fill(Theme.line).frame(width: 1).frame(maxHeight: .infinity) }
      }
      .frame(width: 8)
      VStack(alignment: .leading, spacing: 5) {
        if event.kind == "sql", let sql = event.sql {
          HStack(spacing: 6) {
            if let conn = event.conn {
              Text("c\(conn)").font(Theme.mono(9.5, .bold)).foregroundStyle(Theme.ink)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .background(Capsule().fill(Theme.actor(conn - 1)))
                .help("Connection \(conn)")
            }
            if event.tx == true { Text("tx").font(Theme.mono(9.5)).foregroundStyle(Theme.faint) }
            Text(event.result ?? "").font(Theme.mono(10)).foregroundStyle(event.error != nil ? Theme.fail : Theme.pass.opacity(0.8))
            if let ms = event.ms { Text("\(Int(ms)) ms").font(Theme.mono(9.5)).foregroundStyle(Theme.ghost) }
          }
          Text(SQL.highlight(sql.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)))
            .font(Theme.mono(11)).textSelection(.enabled).lineLimit(4)
          if let params = event.params, !params.isEmpty {
            Text("params " + params.enumerated().map { "$\($0.offset + 1)=\($0.element ?? "null")" }.joined(separator: "  "))
              .font(Theme.mono(10)).foregroundStyle(Theme.flaky.opacity(0.8)).lineLimit(1)
          }
          ForEach(Array((event.sources ?? []).enumerated()), id: \.offset) { _, s in
            HStack(spacing: 6) {
              Text("←").foregroundStyle(Theme.faint)
              if let who = s.who, !who.isEmpty { Text(who.joined(separator: ",")).foregroundStyle(Theme.actor(0)) }
              if let what = s.what { Text(what).foregroundStyle(Theme.dim) }
              if let h = s.handler { Text("\(h)\(s.lines.map { ":" + $0.joined(separator: ",") } ?? "")").foregroundStyle(Theme.accent.opacity(0.85)) }
            }
            .font(Theme.mono(10))
          }
        } else {
          Text(event.text ?? "").font(Theme.mono(11)).italic().foregroundStyle(Theme.flaky.opacity(0.9))
        }
      }
      Spacer(minLength: 0)
    }
  }

  private var dotColor: Color {
    if event.error != nil { return Theme.fail }
    if event.kind != "sql" { return Theme.flaky }
    let s = event.sql?.uppercased() ?? ""
    return s.hasPrefix("SELECT") ? Theme.faint : Theme.accent
  }
}

// MARK: - Database

struct DatabaseTab: View {
  let rep: RepView?

  var body: some View {
    if let diff = rep?.diff, !diff.tables.isEmpty {
      VStack(alignment: .leading, spacing: 16) {
        ForEach(diff.tables.keys.sorted(), id: \.self) { name in
          let t = diff.tables[name]!
          Panel(name, mono: true, accessory: {
            HStack(spacing: 6) {
              if !t.added.isEmpty { Text("+\(t.added.count)").foregroundStyle(Theme.pass) }
              if !t.removed.isEmpty { Text("−\(t.removed.count)").foregroundStyle(Theme.fail) }
              if !t.changed.isEmpty { Text("~\(t.changed.count)").foregroundStyle(Theme.flaky) }
            }
            .font(Theme.mono(10, .semibold))
          }) {
            VStack(alignment: .leading, spacing: 5) {
              ForEach(Array(t.added.prefix(20).enumerated()), id: \.offset) { _, row in diffRow("+", row.fields, Theme.pass) }
              ForEach(Array(t.removed.prefix(20).enumerated()), id: \.offset) { _, row in diffRow("−", row.fields, Theme.fail) }
              ForEach(Array(t.changed.prefix(20).enumerated()), id: \.offset) { _, c in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text("~").foregroundStyle(Theme.flaky).frame(width: 10)
                  Text(Short.value(c.key)).foregroundStyle(Theme.faint)
                  ForEach(c.changes.keys.sorted(), id: \.self) { field in
                    let pair = c.changes[field]!
                    if case .array(let v) = pair, v.count == 2 {
                      HStack(spacing: 4) {
                        Text(field).foregroundStyle(Theme.dim)
                        Text(Short.value(v[0])).foregroundStyle(Theme.fail.opacity(0.85)).strikethrough(color: Theme.fail.opacity(0.5))
                        Text("→").foregroundStyle(Theme.faint)
                        Text(Short.value(v[1])).foregroundStyle(Theme.pass)
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

  private func diffRow(_ sign: String, _ fields: [(String, JSONValue)], _ color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(sign).foregroundStyle(color).frame(width: 10)
      ForEach(fields, id: \.0) { k, v in
        HStack(spacing: 2) {
          Text(k + "=").foregroundStyle(Theme.faint)
          Text(Short.value(v, max: 28)).foregroundStyle(Theme.text.opacity(0.9))
        }
      }
    }
    .font(Theme.mono(11))
    .lineLimit(1)
  }
}

// MARK: - Network

struct NetworkTab: View {
  let rep: RepView?
  @State private var all = false

  var body: some View {
    if let rep {
      let requests = rep.requests.filter { all || $0.notable }
      Panel("Requests", accessory: {
        Toggle(isOn: $all.animation(Theme.spring)) {
          Text("Page loads").font(Theme.sans(11.5)).foregroundStyle(Theme.faint)
        }
        .toggleStyle(.checkbox)
        .controlSize(.mini)
      }) {
        Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 5) {
          GridRow {
            ForEach(["#", "at", "tab", "request", "status", "time", "sql", "handler"], id: \.self) { Text($0).label() }
          }
          ForEach(requests) { r in
            GridRow {
              Text("\(r.id)").foregroundStyle(Theme.ghost)
              Text(Fmt.ms(r.start)).foregroundStyle(Theme.faint)
              Text(r.tab ?? "–").foregroundStyle(Theme.dim)
              HStack(spacing: 5) {
                Text(r.method).foregroundStyle(r.method == "GET" ? Theme.dim : Theme.accent)
                Text(r.path).foregroundStyle(Theme.text).lineLimit(1)
              }
              Text(r.status.map(String.init) ?? (r.failure ?? "–"))
                .foregroundStyle((r.status ?? 0) >= 400 ? Theme.fail : r.failure != nil ? Theme.flaky : Theme.pass.opacity(0.85))
                .lineLimit(1)
              Text(Fmt.ms((r.end ?? r.start) - r.start)).foregroundStyle(Theme.faint)
              Text(r.sql.map { "\($0.total)\($0.writes > 0 ? " · \($0.writes)w" : "")" } ?? "").foregroundStyle((r.sql?.writes ?? 0) > 0 ? Theme.flaky : Theme.faint)
              Text(r.handler ?? "").foregroundStyle(Theme.accent.opacity(0.75)).lineLimit(1)
            }
            .font(Theme.mono(10.5))
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
      VStack(alignment: .leading, spacing: 16) {
        if let console = rep.console, !console.isEmpty {
          TerminalPanel(title: "Browser console", lines: console.map { Short.value($0, max: 400) }, tint: Theme.flaky)
        }
        if let errors = rep.errors, !errors.isEmpty {
          TerminalPanel(title: "Errors", lines: errors.map { Short.value($0, max: 400) }, tint: Theme.fail)
        }
        TerminalPanel(title: "App log", lines: rep.log)
        if let traces = rep.traces, !traces.isEmpty {
          Panel("Playwright traces", accessory: { Text("npx playwright show-trace <file>").font(Theme.mono(10.5)) }) {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(traces, id: \.self) { t in
                Text(Fmt.tilde(t)).font(Theme.mono(10.5)).foregroundStyle(Theme.accent).textSelection(.enabled)
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

  var body: some View {
    Panel(title, tint: tint, accessory: { Text(Fmt.plural(lines.count, "line")) }) {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
              HStack(alignment: .top, spacing: 10) {
                Text("\(i + 1)").foregroundStyle(Theme.ghost).frame(width: 30, alignment: .trailing)
                Text(color(line)).textSelection(.enabled)
              }
              .font(Theme.mono(10.5))
              .id(i)
            }
          }
          .padding(12)
        }
        .frame(maxHeight: 380)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.well))
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
      : lower.contains("pass") || lower.contains("✓") || lower.contains("ok") ? Theme.pass.opacity(0.85)
      : Theme.dim
    return a
  }
}

struct EmptyBlock: View {
  let text: String

  var body: some View {
    Text(text)
      .font(Theme.sans(12.5))
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
        piece.foregroundColor = Theme.pass
      } else if m.range(at: 2).location != NSNotFound {
        piece.foregroundColor = Theme.flaky
      } else if m.range(at: 3).location != NSNotFound {
        piece.foregroundColor = Theme.error
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

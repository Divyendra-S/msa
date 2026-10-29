import Foundation

nonisolated enum Fmt {
  static func ms(_ n: Double?) -> String {
    guard let n, n.isFinite else { return "–" }
    if n < 1000 { return "\(Int(n.rounded())) ms" }
    if n < 60_000 { return String(format: n < 10_000 ? "%.2f s" : "%.1f s", n / 1000) }
    return "\(Int(n / 60_000)) min \(Int((n.truncatingRemainder(dividingBy: 60_000) / 1000).rounded())) s"
  }

  static func kilo(_ n: Double) -> String {
    func one(_ x: Double) -> String {
      let s = String(format: "%.1f", x)
      return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
    }
    return n >= 1_000_000 ? "\(one(n / 1_000_000))M" : n >= 1000 ? "\(one(n / 1000))k" : "\(Int(n))"
  }

  static func usd(_ n: Double) -> String {
    n == 0 ? "$0" : n < 0.01 ? String(format: "$%.4f", n) : String(format: "$%.2f", n)
  }

  static func ago(_ date: Date?, now: Date = .now) -> String {
    guard let date else { return "" }
    let s = max(0, Int(now.timeIntervalSince(date)))
    if s < 60 { return "\(s)s ago" }
    if s < 3600 { return "\(s / 60)m ago" }
    if s < 86_400 { return "\(s / 3600)h ago" }
    return "\(s / 86_400)d ago"
  }

  static func clock(_ date: Date?) -> String {
    guard let date else { return "" }
    return date.formatted(date: .omitted, time: .standard)
  }

  /// Hours and minutes, for headings: 12:32 PM.
  static func time(_ date: Date?) -> String {
    guard let date else { return "" }
    return date.formatted(date: .omitted, time: .shortened)
  }

  static func day(_ date: Date?) -> String {
    guard let date else { return "" }
    if Calendar.current.isDateInToday(date) { return "today" }
    if Calendar.current.isDateInYesterday(date) { return "yesterday" }
    return date.formatted(.dateTime.month(.abbreviated).day())
  }

  static func plural(_ n: Int, _ word: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? word : (many ?? word + "s"))"
  }

  /// A path with the home folder as ~.
  static func tilde(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
  }
}

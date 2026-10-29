import Foundation

// The local API's shapes (packages/viewer/src/server.ts and @windtunnel/core's runner/view.ts).
// Optional wherever the API may leave a field out; free-form parts are JSONValue.

nonisolated struct Status: Decodable, Sendable {
  struct Project: Decodable, Sendable {
    let name: String
    let root: String
    let repoRoot: String?
    let appSubdir: String?
  }
  struct Host: Decodable, Sendable {
    let ok: Bool
    let reason: String?
    let command: [String]?
    let models: [String]?
    let defaultModel: String?
  }
  struct Hunt: Decodable, Sendable {
    let ok: Bool
    let reason: String?
    let skill: String?
    let running: HuntInfo?
    let hosts: [String: Host]?
  }
  struct Jobs: Decodable, Sendable {
    let running: RunJob?
  }
  struct Budget: Decodable, Sendable {
    let tokens: Double
    let usd: Double
  }
  let project: Project
  let hunt: Hunt
  let decider: String?
  let budget: Budget?
  let users: [String]?
  let jobs: Jobs?
}

nonisolated struct RunListEntry: Decodable, Identifiable, Hashable, Sendable {
  struct Progress: Decodable, Hashable, Sendable {
    let done: Int
    let total: Int
  }
  let id: String
  let experiment: String
  let version: String?
  let startedAt: String
  let outcome: String
  let headline: String?
  let running: Progress?

  var started: Date { ISO.date(startedAt) ?? .distantPast }
  /// The rules this run broke, read from its headline ("fail · one-order-per-cart 2/2, …").
  var brokenRules: [String] {
    guard let headline, let dot = headline.range(of: " · ") else { return [] }
    return headline[dot.upperBound...].split(separator: ",").compactMap { part in
      part.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init)
    }.filter { !$0.isEmpty && $0.contains("-") }
  }
}

nonisolated struct Experiment: Decodable, Hashable, Sendable {
  let id: String
  let description: String?
  let flow: String?
  let repeatCount: Int?
  let file: String?

  enum CodingKeys: String, CodingKey {
    case id, description, flow, file
    case repeatCount = "repeat"
  }
}

nonisolated struct ExperimentEntry: Decodable, Identifiable, Hashable, Sendable {
  struct Last: Decodable, Hashable, Sendable {
    let run: String
    let outcome: String
    let headline: String?
    let startedAt: String
  }
  let id: String
  let description: String?
  let flow: String?
  let users: [String]?
  let repeatCount: Int?
  let file: String
  let perturb: Int?
  let last: Last?

  enum CodingKeys: String, CodingKey {
    case id, description, flow, users, file, perturb, last
    case repeatCount = "repeat"
  }
}

nonisolated struct RepSummary: Decodable, Hashable, Sendable {
  let rep: Int
  let variant: String
  let outcome: String
  let broken: [String]?
  let durationMs: Double?
  let diff: String?
  let error: String?
}

nonisolated struct VariantSummary: Decodable, Hashable, Sendable {
  let variant: String
  let runs: Int
  let ok: Int
  let broken: Int
  let errors: Int
  let outcome: String
  let flakeRate: Double?
  let rules: [String: Int]?
}

nonisolated struct ExperimentResult: Decodable, Sendable {
  struct Version: Decodable, Sendable {
    let id: String?
    let label: String?
  }
  let outcome: String
  let variants: [VariantSummary]?
  let reps: [RepSummary]
  let startedAt: String?
  let durationMs: Double?
  let version: Version?
  let touched: [String]?
}

nonisolated struct RunDetail: Decodable, Sendable {
  struct Reference: Decodable, Sendable {
    let run: String
    let rep: Int
    let label: String
    let experimentChanged: Bool?
  }
  struct Triage: Decodable, Sendable {
    let label: String?
    let reason: String
    let by: String
    let decision: String?
  }
  let id: String
  let experiment: Experiment
  let result: ExperimentResult?
  let reps: [RepSummary]
  let total: Int
  let focus: Int?
  let reference: Reference?
  let triage: Triage?
}

nonisolated struct StepAction: Decodable, Hashable, Sendable {
  let at: Double
  let action: String
}

nonisolated struct Seen: Decodable, Hashable, Sendable {
  let path: String
  let text: String
}

nonisolated struct StepRecord: Decodable, Hashable, Sendable {
  let tab: String
  let step: String
  let attempt: String?
  let start: Double
  let end: Double
  let actions: [StepAction]?
  let harness: [String]?
  let error: String?
  let quiet: Bool?
  let seen: Seen?
}

nonisolated struct SqlCount: Decodable, Hashable, Sendable {
  let total: Int
  let writes: Int
  let errors: Int
}

nonisolated struct RequestView: Decodable, Identifiable, Hashable, Sendable {
  let id: Int
  let tab: String?
  let step: String?
  let method: String
  let url: String
  let type: String?
  let start: Double
  let response: Double?
  let end: Double?
  let status: Int?
  let failure: String?
  let path: String
  let notable: Bool
  let handler: String?
  let sql: SqlCount?
}

nonisolated struct RuleResult: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let ok: Bool
  let rows: [JSONValue]?
  let error: String?
  let description: String?
  let sql: String?
}

nonisolated struct DbDiff: Decodable, Sendable {
  struct Change: Decodable, Sendable {
    let key: JSONValue
    let changes: [String: JSONValue]
  }
  struct Table: Decodable, Sendable {
    let added: [JSONValue]
    let removed: [JSONValue]
    let changed: [Change]
  }
  let tables: [String: Table]
}

nonisolated struct ChainSource: Decodable, Hashable, Sendable {
  let who: [String]?
  let what: String?
  let handler: String?
  let lines: [String]?
}

nonisolated struct ChainEvent: Decodable, Hashable, Sendable {
  let at: Double
  let kind: String
  let sql: String?
  let params: [String?]?
  let result: String?
  let error: String?
  let conn: Int?
  let tx: Bool?
  let ms: Double?
  let text: String?
  let sources: [ChainSource]?
}

nonisolated struct TableTrace: Decodable, Hashable, Sendable {
  let table: String
  let change: String?
  let events: [ChainEvent]
  let more: Int?
}

nonisolated struct Trace: Decodable, Sendable {
  let focus: [String]
  let tables: [TableTrace]
  let more: [String]?
}

nonisolated struct Webhook: Decodable, Hashable, Sendable {
  struct Delivery: Decodable, Hashable, Sendable {
    let at: String?
    let status: Int?
    let ms: Double?
    let error: String?
  }
  let event: String
  let type: String
  let charge: String?
  let deliveries: [Delivery]
  let path: String?
}

nonisolated struct RepView: Decodable, Sendable {
  let run: String
  let experiment: String
  let rep: Int
  let variant: String
  let outcome: String
  let error: String?
  let durationMs: Double
  let startedAt: String?
  let diffSummary: String?
  let warnings: [String]?
  let steps: [StepRecord]
  let requests: [RequestView]
  let rules: [RuleResult]
  let errors: [JSONValue]?
  let diff: DbDiff?
  let trace: Trace?
  let webhooks: [Webhook]?
  let console: [JSONValue]?
  let screenshots: [String]
  let traces: [String]?
  let log: [String]
}

nonisolated struct LaneView: Decodable, Hashable, Sendable {
  let run: String
  let rep: Int
  let experiment: String
  let variant: String
  let outcome: String
  let broken: [String]
  let error: String?
  let durationMs: Double
  let diff: String
}

nonisolated struct LaneRequest: Decodable, Hashable, Sendable {
  let id: Int
  let method: String
  let path: String
  let status: Int?
  let failure: String?
  let harness: [String]?
  let start: Double
  let end: Double?
  let sql: SqlCount?
  let divergent: Bool?
}

nonisolated struct LaneStep: Decodable, Hashable, Sendable {
  let start: Double
  let end: Double
  let writes: Int?
  let `as`: String?
  let error: String?
  let harness: [String]
  let quiet: Bool
  let requests: [LaneRequest]
  let seen: Seen?
  let seenDiffers: Bool?
}

nonisolated struct AlignedRow: Decodable, Hashable, Sendable {
  let tab: String
  let step: String
  let attempt: String?
  let cells: [LaneStep?]
}

nonisolated struct Divergence: Decodable, Hashable, Sendable {
  let tab: String
  let at: Double
  let row: Int
  let ours: String
  let theirs: String
}

nonisolated struct Comparison: Decodable, Sendable {
  let lanes: [LaneView]
  let rows: [AlignedRow]
  let reference: Int
  let divergence: [Divergence?]
}

nonisolated struct HuntUsage: Decodable, Hashable, Sendable {
  let input: Double
  let output: Double
  let cached: Double
  let usd: Double
}

nonisolated struct HuntInfo: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let prompt: String
  let command: [String]?
  let startedAt: String
  let endedAt: String?
  let status: String
  let exitCode: Int?
  let usage: HuntUsage
  let events: Int
  let host: String?
  let model: String?
  let budgetUsd: Double?
}

nonisolated struct HuntEvent: Decodable, Identifiable, Hashable, Sendable {
  let seq: Int
  let at: Double
  let kind: String
  let type: String?
  let text: String?
  let tool: String?
  let usage: HuntUsage?
  var id: Int { seq }
}

nonisolated struct HuntDetail: Decodable, Sendable {
  let info: HuntInfo
  let events: [HuntEvent]
}

nonisolated struct RunJob: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let experiments: [String]
  let repeatCount: Int?
  let startedAt: String
  let endedAt: String?
  let status: String
  let exitCode: Int?
  let error: String?
  let output: [String]

  enum CodingKeys: String, CodingKey {
    case id, experiments, startedAt, endedAt, status, exitCode, error, output
    case repeatCount = "repeat"
  }
}

nonisolated struct UsageTotals: Decodable, Identifiable, Hashable, Sendable {
  struct Decisions: Decodable, Hashable, Sendable {
    let rules: Int?
    let spark: Int?
    let jev: Int?
    let agent: Int?
  }
  let job: String
  let toolCalls: Int
  let tokens: Double
  let maxTokens: Double?
  let decisions: Decisions?
  let usd: Double
  let levelOneTokens: Double?
  let last: String?
  var id: String { job }
}

nonisolated struct Usage: Decodable, Sendable {
  let budget: Status.Budget
  let jobs: [UsageTotals]
}

nonisolated struct Evidence: Decodable, Sendable {
  let text: String
}

/// One message on `/api/events`.
nonisolated enum ServerEvent: Sendable {
  case runs(changed: [String])
  case usage
  case hunt(id: String, info: HuntInfo)
  case huntEvent(id: String, event: HuntEvent)
  case job(id: String, info: RunJob)
  case jobOutput(id: String, line: String)
  case other

  static func parse(_ data: Data) -> ServerEvent {
    struct Head: Decodable { let type: String }
    struct Runs: Decodable { let changed: [String] }
    struct Hunt: Decodable { let id: String; let info: HuntInfo }
    struct HuntEv: Decodable { let id: String; let event: HuntEvent }
    struct Job: Decodable { let id: String; let info: RunJob }
    struct JobOut: Decodable { let id: String; let line: String }
    let d = JSONDecoder()
    guard let head = try? d.decode(Head.self, from: data) else { return .other }
    switch head.type {
    case "runs": return (try? d.decode(Runs.self, from: data)).map { .runs(changed: $0.changed) } ?? .other
    case "usage": return .usage
    case "hunt": return (try? d.decode(Hunt.self, from: data)).map { .hunt(id: $0.id, info: $0.info) } ?? .other
    case "hunt-event": return (try? d.decode(HuntEv.self, from: data)).map { .huntEvent(id: $0.id, event: $0.event) } ?? .other
    case "job": return (try? d.decode(Job.self, from: data)).map { .job(id: $0.id, info: $0.info) } ?? .other
    case "job-output": return (try? d.decode(JobOut.self, from: data)).map { .jobOutput(id: $0.id, line: $0.line) } ?? .other
    default: return .other
    }
  }
}

/// Any JSON, for rule rows, database rows and SQL parameters.
nonisolated enum JSONValue: Decodable, Hashable, Sendable, CustomStringConvertible {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }

  var description: String {
    switch self {
    case .string(let s): s
    case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
    case .bool(let b): String(b)
    case .null: "null"
    case .array(let a): "[" + a.map(\.description).joined(separator: ", ") + "]"
    case .object(let o): "{" + o.keys.sorted().map { "\($0): \(o[$0]!.description)" }.joined(separator: ", ") + "}"
    }
  }

  /// Object fields in a stable order (id first), for table rows.
  var fields: [(String, JSONValue)] {
    guard case .object(let o) = self else { return [("value", self)] }
    return o.keys.sorted { a, b in
      if a == "id" { return true }
      if b == "id" { return false }
      return a < b
    }.map { ($0, o[$0]!) }
  }
}

enum ISO {
  nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

  nonisolated static func date(_ s: String?) -> Date? {
    guard let s else { return nil }
    return withFraction.date(from: s) ?? plain.date(from: s)
  }
}

/// The app as one picture (`/api/map`): its pages, the routes they call, the tables those write
/// and the services they call, read from the code; and for each experiment, how its newest run
/// went through them and where it pushed.
nonisolated struct AppMap: Decodable, Sendable {
  struct Page: Decodable, Hashable, Sendable {
    struct Visit: Decodable, Hashable, Sendable {
      let `as`: String
      let status: Int
      let final: String?
    }
    let path: String
    let file: String
    /// A layout: around every page under its path.
    let layout: Bool
    let login: Bool
    let buttons: [String]
    let fields: [String]
    let texts: [String]
    /// Route keys: `POST /api/orders`.
    let calls: [String]
    /// How the live crawl found it, per user.
    let visits: [Visit]
  }

  struct Route: Decodable, Hashable, Sendable {
    struct Effect: Decodable, Hashable, Sendable {
      /// auth, read, write or call.
      let kind: String
      let text: String
      /// Inside a transaction.
      let tx: Bool
    }
    let key: String
    let method: String
    let path: String
    let file: String
    let comment: String?
    let flags: [String]
    let notes: [String]
    let reads: [String]
    let writes: [String]
    let services: [String]
    let effects: [Effect]
    /// Called from outside the app (a payment provider), not by a page.
    let webhook: Bool
  }

  struct Call: Decodable, Hashable, Sendable {
    let route: String
    let count: Int
    let tabs: Int
    /// Two were in the app at the same time.
    let together: Bool
    let failed: Int
  }

  struct Step: Decodable, Hashable, Sendable {
    let name: String
    let pages: [String]
    let calls: [Call]
  }

  /// Where an experiment pushes (`at once`, `double submit`, `webhook twice`), and the routes that lands on.
  struct Pressure: Decodable, Hashable, Sendable {
    let what: String
    let routes: [String]
    let step: String?
  }

  struct Run: Decodable, Hashable, Sendable {
    let id: String
    let outcome: String
    let headline: String
    let startedAt: String
    /// The repetition its steps come from.
    let rep: Int
    let reps: Int
    let broken: [String]
  }

  struct Experiment: Decodable, Hashable, Sendable, Identifiable {
    let id: String
    let description: String?
    let users: [String]
    let pressure: [Pressure]
    let run: Run?
    let pages: [String]
    let routes: [String]
    /// Tables its newest run changed.
    let tables: [String]
    let steps: [Step]
  }

  struct Crawl: Decodable, Sendable {
    let at: String
    let stale: Bool
  }

  let framework: String
  let pages: [Page]
  let routes: [Route]
  let tables: [String]
  let services: [String]
  let experiments: [Experiment]
  let crawl: Crawl?
}

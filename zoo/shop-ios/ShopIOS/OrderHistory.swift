import Foundation
import SQLite3

/// An order placed on this phone, as the phone keeps it.
nonisolated struct HistoryEntry: Sendable {
    let orderId: Int
    let status: String
    let totalCents: Int
}

/// The orders placed on this phone, in a SQLite file in Application Support (`shop.sqlite`): they
/// show offline and after a restart.
actor OrderHistory {
    private let db: OpaquePointer?

    init() {
        let dir = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var handle: OpaquePointer?
        sqlite3_open(dir.appending(path: "shop.sqlite").path, &handle)
        db = handle
        Self.run(handle, "PRAGMA journal_mode = WAL")
        Self.run(handle, "CREATE TABLE IF NOT EXISTS orders (order_id INTEGER PRIMARY KEY, status TEXT NOT NULL, total_cents INTEGER NOT NULL)")
    }

    /// Records an order, or moves its status on: a settled order (paid or failed) stays settled.
    func record(orderId: Int, status: String, totalCents: Int) {
        Self.run(
            db,
            """
            INSERT INTO orders (order_id, status, total_cents) VALUES (?, ?, ?)
            ON CONFLICT (order_id) DO UPDATE SET status = excluded.status
            WHERE orders.status NOT IN ('paid', 'failed')
            """,
            [.int(orderId), .text(status), .int(totalCents)]
        )
    }

    /// Moves a recorded order's status on, as `record` does; an order not recorded stays unrecorded.
    func update(orderId: Int, status: String) {
        Self.run(
            db,
            "UPDATE orders SET status = ? WHERE order_id = ? AND status NOT IN ('paid', 'failed')",
            [.text(status), .int(orderId)]
        )
    }

    /// Newest first.
    func all() -> [HistoryEntry] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT order_id, status, total_cents FROM orders ORDER BY order_id DESC", -1, &statement, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(statement) }
        var entries: [HistoryEntry] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            entries.append(HistoryEntry(
                orderId: Int(sqlite3_column_int64(statement, 0)),
                status: String(cString: sqlite3_column_text(statement, 1)),
                totalCents: Int(sqlite3_column_int64(statement, 2))
            ))
        }
        return entries
    }

    /// Brings the history up to date with the shop's list, when a push says orders changed.
    func refresh(from api: ShopApi) async throws {
        let remote = try await api.orders()
        // Written once the list is here, order by order: whatever was recorded meanwhile stays.
        for order in remote {
            record(orderId: order.id, status: order.status, totalCents: order.totalCents)
        }
    }

    private enum Value {
        case int(Int)
        case text(String)
    }

    private static func run(_ db: OpaquePointer?, _ sql: String, _ values: [Value] = []) {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { return }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, value) in values.enumerated() {
            switch value {
            case .int(let n): sqlite3_bind_int64(statement, Int32(i + 1), Int64(n))
            case .text(let s): sqlite3_bind_text(statement, Int32(i + 1), s, -1, transient)
            }
        }
        while sqlite3_step(statement) == SQLITE_ROW {}
    }
}

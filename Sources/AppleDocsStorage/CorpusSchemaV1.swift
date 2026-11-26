import Foundation

/// Clean Swift v1 SQLite schema DDL loader and idempotent initializer.
///
/// Loads the canonical DDL from the bundled `schema-v1.sql` resource, applying tables,
/// indexes, FTS5/trigram virtual tables, canonical `WHEN`-guarded triggers, and
/// `PRAGMA user_version = 1`.
public enum CorpusSchemaV1: Sendable {
    /// Canonical `PRAGMA user_version` tag written into every Swift v1 corpus database.
    public static let userVersion = CorpusSchemaVersion.swiftV1.rawValue

    /// Applies the full idempotent Swift v1 DDL and records `PRAGMA user_version = 1`.
    public static func apply(to connection: SQLiteConnection) throws(SQLiteError) {
        let ddl = try loadDDL()
        try connection.executeScript(ddl)
        try addMissingColumns(on: connection)
        try connection.setUserVersion(userVersion)
    }

    /// Columns added to v1 after its first release, applied to databases created before them (additive only).
    static let addedColumns: [(table: String, column: String, definition: String)] = [
        ("documents", "platforms_json", "TEXT"),
        ("roots", "last_seen", "TEXT")
    ]

    private static func addMissingColumns(on connection: SQLiteConnection) throws(SQLiteError) {
        for added in addedColumns {
            let existing = try connection.query("PRAGMA table_info(\(added.table))")
            let names = try existing.map { row throws(SQLiteError) in try row.text(at: 1) }
            guard !names.contains(added.column) else { continue }
            try connection.executeScript("ALTER TABLE \(added.table) ADD COLUMN \(added.column) \(added.definition);")
        }
    }

    private static func loadDDL() throws(SQLiteError) -> String {
        guard let url = Bundle.module.url(forResource: "schema-v1", withExtension: "sql") else {
            throw .transactionFailed("Missing bundled schema-v1.sql resource.")
        }
        do {
            return try String(contentsOf: url, encoding: .utf8)
        } catch {
            throw .transactionFailed("Unable to read schema-v1.sql: \(error)")
        }
    }
}

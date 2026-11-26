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
        try connection.setUserVersion(userVersion)
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

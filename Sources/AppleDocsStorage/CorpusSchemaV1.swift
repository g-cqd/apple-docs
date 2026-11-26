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
    // @dl:accept -- declarative column list (same tuple-array shape as WebAssetCatalog's manifest)
    static let addedColumns: [(table: String, column: String, definition: String)] = [
        ("documents", "platforms_json", "TEXT"),
        ("roots", "last_seen", "TEXT"),
        ("crawl_state", "etag", "TEXT"),
        ("crawl_state", "last_modified", "TEXT")
    ]

    /// Indexes added to v1 after its first release (idempotent DDL).
    static let addedIndexes = [
        "CREATE INDEX IF NOT EXISTS idx_crawl_root_status_path ON crawl_state(root_slug, status, path);",
        """
        CREATE TABLE IF NOT EXISTS framework_synonyms (
            canonical TEXT NOT NULL, alias TEXT NOT NULL UNIQUE, PRIMARY KEY (canonical, alias)
        );
        """,
        "CREATE VIRTUAL TABLE IF NOT EXISTS documents_trigram_vocab USING fts5vocab(documents_trigram, 'row');",
        "CREATE INDEX IF NOT EXISTS idx_crawl_queue ON crawl_state(status, depth, path);"
    ]

    /// Whether `documents_body_fts` predates the contentless (Bun-compatible) definition and must be rebuilt.
    static func bodyIndexNeedsRebuild(on connection: SQLiteConnection) throws(SQLiteError) -> Bool {
        let row = try connection.queryOne("SELECT sql FROM sqlite_master WHERE name = 'documents_body_fts'")
        guard let sql = try row?.optionalText(at: 0) else { return false }
        return !sql.contains("content=''")
    }

    /// Adds ``addedColumns`` and ``addedIndexes`` missing from an existing v1 database (every read-write open).
    static func addMissingColumns(on connection: SQLiteConnection) throws(SQLiteError) {
        for added in addedColumns {
            let existing = try connection.query("PRAGMA table_info(\(added.table))")
            let names = try existing.map { row throws(SQLiteError) in try row.text(at: 1) }
            guard !names.contains(added.column) else { continue }
            try connection.executeScript("ALTER TABLE \(added.table) ADD COLUMN \(added.column) \(added.definition);")
        }
        for ddl in addedIndexes { try connection.executeScript(ddl) }
    }

    private static func loadDDL() throws(SQLiteError) -> String {
        EmbeddedCorpusSchema.text + "\n" + EmbeddedAssetSchema.text
    }
}

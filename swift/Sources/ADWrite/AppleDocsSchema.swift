// AppleDocsSchema — the apple-docs catalog on REAL SQLite (the storage pivot,
// RFC 0007 §11/§12: ADDB is dropped as the storage engine; the corpus format
// converges back to the JS `bun:sqlite` format). This file is the migration
// RUNNER — the literal port of `src/storage/migrations/index.js`:
//
//   • the ladder is the 27 JS migrations, VERBATIM SQL per version step (the
//     step bodies live in `AppleDocsSchema+InitialSchema.swift` /
//     `+LegacyLadder.swift` / `+ModernLadder.swift`), with version 16 == the JS
//     `v15a` — so a
//     fresh native DB lands byte-for-byte on the JS catalog
//     (`Tests/ADWriteTests/Fixtures/js-sqlite-catalog.json` is the committed
//     truth), and an OLD JS-era corpus migrates forward natively.
//   • the runner walks every migration whose version exceeds the current
//     `schema_meta.schema_version`, inside ONE deferred transaction (the JS
//     `BEGIN` … `COMMIT`), writes the terminal version once, and rolls back
//     wholesale on any failure.
//   • a future-version corpus throws (downgrade protection), and an up-to-date
//     corpus returns without writing — both verbatim `applyMigrations` semantics.
//
// Sequencing note (`src/storage/pragmas.js`): the JS boot is applyPragmas →
// runMigrations → enableForeignKeys. The connection's `init` applies the pragmas;
// `migrateSchema` runs the ladder and then enables FK enforcement itself, so
// every caller (CLI verbs, tests) gets the full JS boot from one call.

public import ADStorage

/// One `migrateSchema` run's outcome: the version the catalog started at, the
/// version it landed on, and how many ladder steps applied.
public struct MigrateOutcome: Sendable, Equatable {
    public let startingVersion: Int
    public let finalVersion: Int
    public let appliedCount: Int
}

/// The apple-docs schema as the ordered JS migration ladder. Versions mirror the
/// JS `MIGRATIONS` list exactly (1…27, where version 16 is the JS `v15a`).
public enum AppleDocsSchema {
    /// The JS `SCHEMA_VERSION` — the last entry of the MIGRATIONS list.
    public static let latestVersion = 27

    /// Every migration, ascending — one per JS version step.
    static let migrations: [(version: Int, apply: @Sendable (SQLiteWriteConnection) throws(SQLiteWriteError) -> Void)] =
        [
            (1, v1), (2, v2), (3, v3), (4, v4), (5, v5), (6, v6), (7, v7), (8, v8), (9, v9),
            (10, v10), (11, v11), (12, v12), (13, v13), (14, v14), (15, v15), (16, v15a),
            (17, v17), (18, v18), (19, v19), (20, v20), (21, v21), (22, v22), (23, v23),
            (24, v24), (25, v25), (26, v26), (27, v27)
        ]

    // MARK: - guarded ALTER helpers (the JS try/catch idioms)

    /// `ALTER TABLE … ADD COLUMN` guarded like the loose JS migrations (v3/v5/v12/
    /// v24/v26): ANY failure is swallowed (the column already exists on a re-run).
    static func alterIgnoringFailure(_ db: SQLiteWriteConnection, _ sql: String) {
        try? db.run(sql)
    }

    /// `ALTER TABLE … ADD COLUMN` guarded like the strict JS migrations (v15a/v17/
    /// v18/v19/v27): a "duplicate column name" error is swallowed (idempotent
    /// re-run); any OTHER error rethrows.
    static func alterIgnoringDuplicateColumn(
        _ db: SQLiteWriteConnection, _ sql: String
    ) throws(SQLiteWriteError) {
        do {
            try db.run(sql)
        } catch {
            guard error.description.lowercased().contains("duplicate column name") else { throw error }
        }
    }
}

/// Run the full apple-docs migration ladder against `db` — the literal
/// `runMigrations` (`src/storage/migrations/index.js`): create `schema_meta`,
/// read the current `schema_version`, refuse a future-version corpus, and apply
/// every pending step inside one deferred transaction, recording the terminal
/// version once. Enables foreign-key enforcement afterwards (the JS
/// `enableForeignKeys` boot step).
///
/// Idempotent: an up-to-date catalog returns without writing.
///
/// - Parameter db: an open, writable SQLite connection (writer pragmas applied).
/// - Returns: the ``MigrateOutcome`` (starting/final versions, applied count).
/// - Throws: ``SQLiteWriteError/migration(_:)`` for a future-version corpus, or
///   the failing statement's error (the transaction rolls back wholesale).
@discardableResult
public func migrateSchema(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> MigrateOutcome {
    try db.run("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    let row = try db.get(
        "SELECT value FROM schema_meta WHERE key = $key", ["key": .text("schema_version")])
    let current = row.flatMap { $0.text("value") }.flatMap { Int($0) } ?? 0

    if current > AppleDocsSchema.latestVersion {
        throw SQLiteWriteError.migration(
            "Database schema version \(current) is newer than supported version "
                + "\(AppleDocsSchema.latestVersion). Update apple-docs to a newer version.")
    }
    if current == AppleDocsSchema.latestVersion {
        try db.enableForeignKeys()
        return MigrateOutcome(startingVersion: current, finalVersion: current, appliedCount: 0)
    }

    var applied = 0
    try db.deferredTransaction { () throws(SQLiteWriteError) in
        for migration in AppleDocsSchema.migrations where current < migration.version {
            try migration.apply(db)
            applied += 1
        }
        try db.run(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', $version)",
            ["version": .text(String(AppleDocsSchema.latestVersion))])
    }
    try db.enableForeignKeys()
    return MigrateOutcome(
        startingVersion: current, finalVersion: AppleDocsSchema.latestVersion, appliedCount: applied)
}

// Migration steps v15a…v27 — the VERBATIM SQL of
// `src/storage/migrations/v15a-numeric-platforms.js` … `v27-*.js`, one Swift
// function per JS `up(db)`. v15a's row-by-row backfill runs in Swift (the JS
// reads rows and encodes versions JS-side — SQLite has no semver parser), using
// the same `encodeVersion` the persist writes new rows through.

import ADStorage

extension AppleDocsSchema {
    /// v15a (ladder version 16) — numeric companion columns for platform minimums:
    /// `min_*_num` INTEGER columns + indexes, backfilled via `encodeVersion`.
    static func v15a(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        let platforms = ["ios", "macos", "watchos", "tvos", "visionos"]
        for platform in platforms {
            let column = "min_\(platform)_num"
            try alterIgnoringDuplicateColumn(db, "ALTER TABLE documents ADD COLUMN \(column) INTEGER")
            try db.run("CREATE INDEX IF NOT EXISTS idx_documents_\(column) ON documents(\(column))")
        }

        // Backfill row-by-row (JS-side encoding; one full-table scan, once).
        let rows = try db.all(
            "SELECT id, min_ios, min_macos, min_watchos, min_tvos, min_visionos FROM documents")
        for row in rows {
            guard let id = row.int("id") else { continue }
            try db.run(
                """
                UPDATE documents SET
                      min_ios_num = $ios,
                      min_macos_num = $macos,
                      min_watchos_num = $watchos,
                      min_tvos_num = $tvos,
                      min_visionos_num = $visionos
                    WHERE id = $id
                """,
                [
                    "id": .integer(id),
                    "ios": CrawlPersist.encodeVersion(row.text("min_ios")),
                    "macos": CrawlPersist.encodeVersion(row.text("min_macos")),
                    "watchos": CrawlPersist.encodeVersion(row.text("min_watchos")),
                    "tvos": CrawlPersist.encodeVersion(row.text("min_tvos")),
                    "visionos": CrawlPersist.encodeVersion(row.text("min_visionos"))
                ])
        }
    }

    /// v17 — `pages.consecutive_404_count` for the N=3 tombstone gate.
    static func v17(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try alterIgnoringDuplicateColumn(
            db, "ALTER TABLE pages ADD COLUMN consecutive_404_count INTEGER NOT NULL DEFAULT 0")
    }

    /// v18 — `sf_symbols.bitmap_only` flag for bitmap-backed private symbols.
    static func v18(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try alterIgnoringDuplicateColumn(
            db, "ALTER TABLE sf_symbols ADD COLUMN bitmap_only INTEGER NOT NULL DEFAULT 0")
    }

    /// v19 — `sf_symbols.codepoint` + the PARTIAL index over non-NULL rows.
    static func v19(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try alterIgnoringDuplicateColumn(db, "ALTER TABLE sf_symbols ADD COLUMN codepoint INTEGER")
        try db.run(
            "CREATE INDEX IF NOT EXISTS idx_sf_symbols_codepoint ON sf_symbols(codepoint) WHERE codepoint IS NOT NULL"
        )
    }

    /// v20 — purge catalog meta-entry rows from `sf_symbols`.
    static func v20(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("DELETE FROM sf_symbols WHERE name IN ('symbols', 'year_to_release')")
    }

    /// v21 — drop the dead legacy pages FTS subsystem and the redundant
    /// document_relationships indexes.
    static func v21(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("DROP TRIGGER IF EXISTS pages_ai")
        try db.run("DROP TRIGGER IF EXISTS pages_ad")
        try db.run("DROP TRIGGER IF EXISTS pages_au")
        try db.run("DROP TABLE IF EXISTS pages_fts")
        try db.run("DROP TABLE IF EXISTS titles_trigram")
        try db.run("DROP TABLE IF EXISTS pages_body_fts")
        try db.run("DROP INDEX IF EXISTS idx_rel_from")
        try db.run("DROP INDEX IF EXISTS idx_rel_to")
    }

    /// v22 — `document_vectors`: the binary-quantized embedding store.
    static func v22(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS document_vectors (
                document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
                vec         BLOB NOT NULL
              )
            """)
    }

    /// v23 — `document_raw`: zstd-compressed raw upstream payloads.
    static func v23(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS document_raw (
                document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
                raw         BLOB NOT NULL
              )
            """)
    }

    /// v24 — `sf_symbols.codepoint_version` (the SF Symbols release a codepoint
    /// was resolved from).
    static func v24(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        alterIgnoringFailure(db, "ALTER TABLE sf_symbols ADD COLUMN codepoint_version TEXT")
    }

    /// v25 — `document_chunks`: the per-chunk embedding store.
    static func v25(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            """
            CREATE TABLE IF NOT EXISTS document_chunks (
                chunk_id    INTEGER PRIMARY KEY AUTOINCREMENT,
                document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                ord         INTEGER NOT NULL,
                text        BLOB,
                vec_bin     BLOB NOT NULL,
                vec_i8      BLOB,
                UNIQUE(document_id, ord)
              )
            """)
        try db.run("CREATE INDEX IF NOT EXISTS idx_chunks_doc ON document_chunks(document_id)")
    }

    /// v26 — `documents.usr` (the Swift/Clang USR join key) + its index.
    static func v26(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        alterIgnoringFailure(db, "ALTER TABLE documents ADD COLUMN usr TEXT")
        try db.run("CREATE INDEX IF NOT EXISTS idx_documents_usr ON documents(usr)")
    }

    /// v27 — `sf_symbols.render_unsupported` flag for build-host-undrawable symbols.
    static func v27(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try alterIgnoringDuplicateColumn(
            db, "ALTER TABLE sf_symbols ADD COLUMN render_unsupported INTEGER NOT NULL DEFAULT 0")
    }
}

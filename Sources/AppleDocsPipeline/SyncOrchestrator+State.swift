import AemiSearch
import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsStorage

extension SyncOrchestrator {
    /// Computes binary quantized `document_vectors` for all documents lacking an embedding yet.
    public static func buildMissingEmbeddings(
        in store: CorpusStore,
        embedder: Model2VecEmbedder,
        limit: Int = 10_000
    ) throws -> Int {
        let rows = try store.connection.query(
            """
            SELECT d.id, d.title, COALESCE(d.abstract_text, ''), COALESCE(d.headings, '')
            FROM documents d
            LEFT JOIN document_vectors v ON v.document_id = d.id
            WHERE v.document_id IS NULL
            ORDER BY d.id ASC
            LIMIT ?
            """,
            bindings: [.integer(Int64(max(1, limit)))]
        )
        guard !rows.isEmpty else { return 0 }
        try store.connection.transaction {
            for row in rows {
                let docID = try row.integer(at: 0)
                let combined = [try row.text(at: 1), try row.text(at: 2), try row.text(at: 3)]
                    .filter { !$0.isEmpty }
                    .joined(separator: " ")
                let quantized = BinaryVectorScorer.quantizeBinary(embedder.embed(combined))
                try store.connection.execute(
                    "INSERT OR REPLACE INTO document_vectors (document_id, vec) VALUES (?, ?)",
                    bindings: [.integer(docID), .blob(quantized)]
                )
            }
        }
        return rows.count
    }

    static func seedQueue(root: CorpusRootRecord, seeds: [DocumentKey], into store: CorpusStore) throws {
        try store.connection.transaction {
            try store.upsertRoot(root)
            for seed in seeds {
                try enqueue(path: seed.rawValue, rootSlug: root.slug, depth: 0, on: store.connection)
            }
        }
    }

    /// Recomputes `roots.page_count` and adopts the seed page title as the root display name (Bun parity).
    static func refreshRootStats(rootSlug: String, seedPath: String?, on db: SQLiteConnection) throws(SQLiteError) {
        try db.execute(
            """
            UPDATE roots SET
                page_count = (SELECT COUNT(*) FROM documents WHERE framework = ?1),
                display_name = COALESCE((SELECT title FROM documents WHERE key = ?2), display_name),
                updated_at = datetime('now')
            WHERE slug = ?1
            """,
            bindings: [.text(rootSlug), .text(seedPath ?? rootSlug)]
        )
    }

    @discardableResult
    static func enqueue(
        path: String,
        rootSlug: String,
        depth: Int,
        on db: SQLiteConnection
    ) throws(SQLiteError) -> Bool {
        try db.execute(
            "INSERT OR IGNORE INTO crawl_state (path, status, root_slug, depth) VALUES (?, 'pending', ?, ?)",
            bindings: [.text(path), .text(rootSlug), .integer(Int64(depth))]
        )
        return try db.changes() > 0
    }

    static func markState(
        path: String,
        status: String,
        error: String?,
        on db: SQLiteConnection
    ) throws(SQLiteError) {
        try db.execute(
            "UPDATE crawl_state SET status = ?, error = ? WHERE path = ?",
            bindings: [.text(status), .optionalText(error), .text(path)]
        )
    }

    static func recordNotFound(
        forKey key: DocumentKey,
        threshold: Int,
        in store: CorpusStore
    ) throws(SQLiteError) -> Bool {
        let counterKey = "404:\(key.rawValue)"
        let current = (try readCheckpoint(key: counterKey, on: store.connection).flatMap(Int.init) ?? 0) + 1
        if current >= threshold {
            try store.deleteDocument(forKey: key)
            try deleteCheckpoint(key: counterKey, on: store.connection)
            return true
        }
        try writeCheckpoint(key: counterKey, value: String(current), on: store.connection)
        return false
    }

    static func clearTombstoneCounter(forKey key: DocumentKey, on db: SQLiteConnection) throws(SQLiteError) {
        try deleteCheckpoint(key: "404:\(key.rawValue)", on: db)
    }

    static func readCheckpoint(key: String, on db: SQLiteConnection) throws(SQLiteError) -> String? {
        let row = try db.queryOne("SELECT value FROM sync_checkpoint WHERE key = ?", bindings: [.text(key)])
        return try row?.optionalText(at: 0)
    }

    static func writeCheckpoint(key: String, value: String, on db: SQLiteConnection) throws(SQLiteError) {
        try db.execute(
            """
            INSERT INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            """,
            bindings: [.text(key), .text(value)]
        )
    }

    static func deleteCheckpoint(key: String, on db: SQLiteConnection) throws(SQLiteError) {
        try db.execute("DELETE FROM sync_checkpoint WHERE key = ?", bindings: [.text(key)])
    }
}

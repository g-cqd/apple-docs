import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsStorage
import Foundation

/// Builds the semantic search index — a port of Bun's `indexEmbeddings` (`commands/index-embeddings.js`): every
/// document's ``DocumentChunker`` chunks embedded, stored as sign bits (Hamming shortlist) and int8 (rescoring) in
/// `document_chunks`, with chunk 0 doubling as the document's anchor in `document_vectors`. Incremental runs embed
/// documents without chunks or updated since the last scan; `full` re-embeds everything.
public enum ChunkEmbeddingIndexer {
    public struct Report: Sendable, Equatable {
        public var documents = 0
        public var chunks = 0
    }

    static let scanCheckpoint = "embed_indexed_at"

    private struct Pending {
        let id: Int64
        let chunks: [String]
    }

    public static func run(
        store: CorpusStore,
        embedder: Model2VecEmbedder,
        modelName: String,
        full: Bool = false,
        batchSize: Int = 512,
        parallelism: Int? = nil
    ) async throws -> Report {
        let parallelism = parallelism ?? ProcessInfo.processInfo.activeProcessorCount
        let db = store.connection
        let scanStartedAt = try db.queryOne("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")?.text(at: 0) ?? ""
        let since =
            full
            ? nil
            : try db.queryOne(
                "SELECT value FROM sync_checkpoint WHERE key = ?",
                bindings: [.text(scanCheckpoint)]
            )?
            .optionalText(at: 0)
        var report = Report()
        var lastID: Int64 = 0
        var wroteMeta = false
        while true {
            let batch = try nextBatch(after: lastID, since: since, full: full, limit: batchSize, store: store)
            guard let last = batch.last else { break }
            lastID = last.id
            let texts = batch.flatMap(\.chunks)
            let vectors = await embed(texts, embedder: embedder, parallelism: parallelism)
            try db.transaction {
                if !wroteMeta, let dims = vectors.first?.count {
                    try setMeta("embed_dims", String(dims), on: db)
                    try setMeta("embed_model", modelName, on: db)
                    wroteMeta = true
                }
                var offset = 0
                for document in batch {
                    try write(document, vectors: vectors[offset ..< offset + document.chunks.count], on: db)
                    offset += document.chunks.count
                }
            }
            report.documents += batch.count
            report.chunks += texts.count
        }
        try db.execute(
            """
            INSERT INTO sync_checkpoint (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            bindings: [.text(scanCheckpoint), .text(scanStartedAt)]
        )
        return report
    }

    /// The next documents to embed (by id), with their chunk texts.
    private static func nextBatch(
        after lastID: Int64,
        since: String?,
        full: Bool,
        limit: Int,
        store: CorpusStore
    ) throws -> [Pending] {
        let filter =
            full
            ? ""
            : """
            AND (id NOT IN (SELECT document_id FROM document_chunks)
                 OR (?2 IS NOT NULL AND julianday(updated_at) > julianday(?2)))
            """
        let rows = try store.connection.query(
            "SELECT id, title, abstract_text, headings FROM documents WHERE id > ?1 \(filter) ORDER BY id LIMIT ?3",
            bindings: [.integer(lastID), .optionalText(since), .integer(Int64(max(1, limit)))]
        )
        guard !rows.isEmpty else { return [] }
        let ids = try rows.map { row throws(SQLiteError) in try row.integer(at: 0) }
        let sections = try sectionsByDocument(ids, on: store.connection)
        return try rows.map { row in
            let id = try row.integer(at: 0)
            return Pending(
                id: id,
                chunks: DocumentChunker.chunks(
                    title: try row.optionalText(at: 1),
                    abstract: try row.optionalText(at: 2),
                    headings: try row.optionalText(at: 3),
                    sections: sections[id] ?? []
                )
            )
        }
    }

    /// `getSectionsByDocumentIds`: sections in `sort_order, id` order, text decoded from zstd when compressed.
    private static func sectionsByDocument(
        _ ids: [Int64],
        on db: SQLiteConnection
    ) throws -> [Int64: [DocumentSectionRecord]] {
        var out: [Int64: [DocumentSectionRecord]] = [:]
        let rows = try db.query(
            """
            SELECT document_id, section_kind, heading, content_text, sort_order FROM document_sections
            WHERE document_id IN (\(SQLiteConnection.placeholders(ids.count)))
            ORDER BY document_id, sort_order, id
            """,
            bindings: ids.map(SQLiteValue.integer)
        )
        for row in rows {
            out[try row.integer(at: 0), default: []]
                .append(
                    DocumentSectionRecord(
                        sectionKind: try row.text(at: 1),
                        heading: try row.optionalText(at: 2),
                        contentText: try ZstdCodec.decodeText(from: try row.value(at: 3)) ?? "",
                        sortOrder: Int(try row.integer(at: 4))
                    )
                )
        }
        return out
    }

    /// Embeds `texts` in order, split across `parallelism` concurrent slices.
    private static func embed(_ texts: [String], embedder: Model2VecEmbedder, parallelism: Int) async -> [[Float]] {
        let slices = max(1, min(parallelism, texts.count))
        let size = (texts.count + slices - 1) / slices
        return await withTaskGroup(of: (Int, [[Float]]).self, returning: [[Float]].self) { group in
            for start in stride(from: 0, to: texts.count, by: max(1, size)) {
                let slice = Array(texts[start ..< min(start + size, texts.count)])
                group.addTask { (start, slice.map(embedder.embed)) }
            }
            var parts: [(Int, [[Float]])] = []
            for await part in group { parts.append(part) }
            return parts.sorted { $0.0 < $1.0 }.flatMap(\.1)
        }
    }

    private static func write(_ document: Pending, vectors: ArraySlice<[Float]>, on db: SQLiteConnection) throws {
        try db.execute("DELETE FROM document_chunks WHERE document_id = ?", bindings: [.integer(document.id)])
        for (ord, vector) in vectors.enumerated() {
            let bits = EmbeddingQuantizer.signBits(vector)
            try db.execute(
                "INSERT INTO document_chunks (document_id, ord, text, vec_bin, vec_i8) VALUES (?, ?, NULL, ?, ?)",
                bindings: [
                    .integer(document.id), .integer(Int64(ord)), .blob(bits), .blob(EmbeddingQuantizer.int8(vector))
                ]
            )
            if ord == 0 {
                try db.execute(
                    "INSERT OR REPLACE INTO document_vectors (document_id, vec) VALUES (?, ?)",
                    bindings: [.integer(document.id), .blob(bits)]
                )
            }
        }
    }

    private static func setMeta(_ key: String, _ value: String, on db: SQLiteConnection) throws(SQLiteError) {
        try db.execute(
            "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES (?, ?)",
            bindings: [.text(key), .text(value)]
        )
    }
}

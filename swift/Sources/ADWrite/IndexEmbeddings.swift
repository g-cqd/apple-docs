// IndexEmbeddings — the native per-chunk embedding index writer on REAL SQLite.
// The bit-faithful port of `indexEmbeddings`
// (apple-docs/src/commands/index-embeddings.js): for every document it builds the
// body-aware chunk set (anchor + heading-aware body chunks), embeds each chunk,
// and stores both quantized codes per chunk —
//   • `vec_bin` ← `Quantize.signCode`  (the Hamming shortlist code)
//   • `vec_i8`  ← `Quantize.i8Code`    (the int8 + f32-scale rescore code)
// — into `document_chunks`, and upserts chunk 0's binary code into the legacy
// `document_vectors` table so the cheap availability gate (`getVectorCount`) and
// old whole-doc readers keep working. `embed_dims` / `embed_model` /
// `embed_version` are recorded in `snapshot_meta` (written with the first batch,
// idempotent) so the reader can width-guard a mismatched snapshot.
//
// ── JS faithful reproduction ──────────────────────────────────────────────────
//   • Chunking is `ADEmbed.Chunker.chunkDocument` (the bit-exact port of
//     src/search/chunker.js — chunk 0 is the anchor).
//   • Quantization is `ADEmbed.Quantize.signCode` / `.i8Code` (the bit-exact ports
//     of src/search/embedding.js `quantizeTo` / `quantizeI8`).
//   • The SQL is the literal JS text: the `document_chunks` upsert (chunks.js
//     `upsertStmt`), the `document_vectors` anchor upsert (index-embeddings.js
//     `anchorUpsert`), the per-doc `DELETE` (chunks.js `deleteByDocStmt`), and the
//     resume scan's `WHERE id NOT IN (SELECT document_id FROM document_chunks)`
//     anti-join — restored verbatim (the interim ADDB engine could not run an
//     `IN (SELECT …)` subquery and did the anti-join in Swift).
//   • Resume semantics match: without `full`, only documents with no chunks are
//     processed; an embedder version bump (`embedVersion`) forces a full re-embed
//     BEFORE the resume scan (so an "up to date" store still re-embeds).
//   • Batching matches (`batchSize` = 64): one transaction per batch wraps the
//     per-doc DELETE-then-insert (dedup on re-index), committing once.
//
// The content codec is NOT applied here: at index time `document_sections`
// carries PLAIN TEXT (the writer path stores plain text; the zstd section codec is
// compact/snapshot-only), so `content_text` is read straight as text — the same
// state in which the JS `getSectionsByDocumentIds` finds it before `compact`.

public import ADEmbed
public import ADStorage

/// The embedding seam the chunk-index writer drives — the Swift analogue of the
/// JS injectable `opts.embedder`. A test passes a deterministic fake (so the gate
/// needs neither the model bundle nor the optional transformer dependency); the
/// real pipeline passes the model2vec ``ADEmbed/Embedder``.
public protocol ChunkEmbedder {
    /// The embedding width (the f32 vector length). Recorded as `embed_dims`.
    var dims: Int { get }
    /// Embed one chunk into a unit-norm f32 vector.
    func embed(_ text: String) throws -> [Float]
}

/// The model2vec embedder is the production conformer: it already exposes `dims`
/// and an `embed(_:)` whose typed `throws(EmbedError)` satisfies the protocol's
/// untyped `throws`.
extension Embedder: ChunkEmbedder {}

/// The native chunks/vectors writer — a namespace of pure write functions over an
/// open, writable SQLite connection whose schema is already at `AppleDocsSchema`.
public enum IndexEmbeddings {
    /// The default pinned model id (`APPLE_DOCS_EMBED_MODEL` resolves the override
    /// JS-side; the caller passes the resolved value).
    public static let defaultModel = "potion-retrieval-32M"

    /// One index run's outcome — the fields of the JS `{ status, indexed, total,
    /// chunks }` return, so a CLI verb or test can assert on it.
    public struct Result: Sendable, Equatable {
        public let status: String
        public let indexed: Int
        public let total: Int
        public let chunks: Int
    }

    /// Build (or resume) the per-chunk embedding index.
    ///
    /// - Parameters:
    ///   - db: an open, writable SQLite connection migrated to `AppleDocsSchema`.
    ///   - embedder: the chunk embedder (model2vec in production; a fake in tests).
    ///   - embedModel: the model id stamped into `snapshot_meta.embed_model`.
    ///   - embedVersion: the embedder behavior version (RFC 0001 §10). When set and
    ///     it differs from the stored `embed_version`, a non-`full` run upgrades to
    ///     a full re-embed (resuming would mix versions in one table). `nil` ⇒ no
    ///     version gating (mirrors the JS `embedVersion === undefined` branch).
    ///   - full: re-embed every document (else only documents with no chunks).
    ///   - batchSize: documents per embed/transaction batch (JS `BATCH` = 64).
    ///   - onProgress: invoked after each committed batch with `(done, total)`.
    /// - Throws: a ``SQLiteWriteError`` (or the embedder's error) if a storage write or embedding pass fails.
    /// - Returns: the run ``Result``.
    @discardableResult
    public static func run(
        _ db: SQLiteWriteConnection,
        embedder: some ChunkEmbedder,
        embedModel: String = defaultModel,
        embedVersion: Int? = nil,
        full: Bool = false,
        batchSize: Int = 64,
        onProgress: ((_ done: Int, _ total: Int) -> Void)? = nil
    ) throws -> Result {
        // A deliberate embedding-behavior change (stamped as `embed_version`)
        // invalidates stored chunks wholesale — resuming would mix versions. Checked
        // BEFORE the resume scan so an "up to date" v1 store still re-embeds under v2.
        var resolvedFull = full
        if !resolvedFull, let embedVersion, try chunkCount(db) > 0 {
            let stored = try getSnapshotMeta(db, "embed_version") ?? "1"
            if stored != String(embedVersion) { resolvedFull = true }
        }

        // ── document scan: full (every doc) or resume (docs with no chunks) — the
        // literal JS scans, including the `NOT IN (SELECT …)` anti-join. ─────────
        let scanSQL =
            resolvedFull
            ? "SELECT id, title, abstract_text, headings FROM documents ORDER BY id"
            : "SELECT id, title, abstract_text, headings FROM documents "
                + "WHERE id NOT IN (SELECT document_id FROM document_chunks) ORDER BY id"
        let docRows = try db.all(scanSQL).compactMap(DocRow.init)
        let total = docRows.count
        if total == 0 {
            return Result(status: "ok", indexed: 0, total: 0, chunks: 0)
        }

        let chunkUpsertSQL = """
            INSERT OR REPLACE INTO document_chunks(document_id, ord, text, vec_bin, vec_i8)
            VALUES ($doc, $ord, $text, $bin, $i8)
            """
        let anchorUpsertSQL =
            "INSERT OR REPLACE INTO document_vectors(document_id, vec) VALUES ($id, $vec)"

        var indexed = 0
        var chunkTotal = 0
        var dims = 0
        var batchStart = 0
        while batchStart < total {
            let batch = Array(docRows[batchStart ..< Swift.min(batchStart + batchSize, total)])
            let sectionsByDoc = try sections(db, forDocumentIds: batch.map(\.id))

            // Flatten every chunk of the batch so each chunk maps back to (doc, ord).
            var flat: [(docId: Int64, ord: Int, text: String)] = []
            for row in batch {
                let chunks = Chunker.chunkDocument(
                    title: row.title, abstractText: row.abstractText, headings: row.headings,
                    sections: sectionsByDoc[row.id] ?? [])
                for (ord, text) in chunks.enumerated() { flat.append((row.id, ord, text)) }
            }

            // Embed, then quantize OUTSIDE the write transaction (keeps the write
            // lock tight; the stored bytes are identical to quantizing inline).
            let codes = try flat.map { chunk -> (bin: [UInt8], i8: [UInt8]) in
                let vec = try embedder.embed(chunk.text)
                if dims == 0 { dims = vec.count }
                return (Quantize.signCode(vec), Quantize.i8Code(vec))
            }

            // Model meta is written with the first non-empty batch (idempotent) so an
            // interrupted run never leaves chunks on disk with absent/stale meta.
            if indexed == 0, !flat.isEmpty {
                try setSnapshotMeta(db, "embed_dims", String(dims))
                try setSnapshotMeta(db, "embed_model", embedModel)
                if let embedVersion { try setSnapshotMeta(db, "embed_version", String(embedVersion)) }
            }

            try db.transaction { () throws(SQLiteWriteError) in
                for row in batch {  // clear stale ords on re-index (per-doc dedup)
                    try db.run(
                        "DELETE FROM document_chunks WHERE document_id = $doc",
                        ["doc": .integer(row.id)])
                }
                for index in flat.indices {
                    let chunk = flat[index]
                    let code = codes[index]
                    try db.run(
                        chunkUpsertSQL,
                        [
                            "doc": .integer(chunk.docId),
                            "ord": .integer(Int64(chunk.ord)),
                            "text": .null,
                            "bin": .blob(code.bin),
                            "i8": .blob(code.i8)
                        ])
                    if chunk.ord == 0 {
                        try db.run(
                            anchorUpsertSQL,
                            ["id": .integer(chunk.docId), "vec": .blob(code.bin)])
                    }
                }
            }

            indexed += batch.count
            chunkTotal += flat.count
            onProgress?(indexed, total)
            batchStart += batchSize
        }

        return Result(status: "ok", indexed: indexed, total: total, chunks: chunkTotal)
    }

    // snapshot_meta single-row helpers (auto-commit each, as the JS does).
    static func setSnapshotMeta(_ db: SQLiteWriteConnection, _ key: String, _ value: String) throws(SQLiteWriteError) {
        try db.run(
            "INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ($key, $value)",
            ["key": .text(key), "value": .text(value)])
    }

    static func getSnapshotMeta(_ db: SQLiteWriteConnection, _ key: String) throws(SQLiteWriteError) -> String? {
        try db.get("SELECT value FROM snapshot_meta WHERE key = $key", ["key": .text(key)])?
            .text("value")
    }

    private static func chunkCount(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> Int64 {
        try db.get("SELECT COUNT(*) AS c FROM document_chunks")?.int("c") ?? 0
    }

    // MARK: - reads

    /// One `documents` row feeding the chunker (the JS resume/full scan projection).
    private struct DocRow {
        let id: Int64
        let title: String?
        let abstractText: String?
        let headings: String?

        init?(_ row: SQLiteRow) {
            guard let id = row.int("id") else { return nil }
            self.id = id
            self.title = row.text("title")
            self.abstractText = row.text("abstract_text")
            self.headings = row.text("headings")
        }
    }

    /// Batched `document_id → [Chunker.Section]` fetch, mirroring
    /// `getSectionsByDocumentIds`: ordered by `(document_id, sort_order, id)` so the
    /// chunk order (and therefore each chunk's `ord`) is identical to the JS writer.
    /// `content_text` is read as plain text (the writer-path state at index time).
    private static func sections(
        _ db: SQLiteWriteConnection, forDocumentIds ids: [Int64]
    ) throws(SQLiteWriteError) -> [Int64: [Chunker.Section]] {
        if ids.isEmpty { return [:] }
        var placeholders: [String] = []
        var params: [String: SQLiteValue] = [:]
        placeholders.reserveCapacity(ids.count)
        for (index, id) in ids.enumerated() {
            let name = "d\(index)"
            placeholders.append("$\(name)")
            params[name] = .integer(id)
        }
        let rows = try db.all(
            """
            SELECT document_id, section_kind, heading, content_text, sort_order
            FROM document_sections WHERE document_id IN (\(placeholders.joined(separator: ", ")))
            ORDER BY document_id, sort_order, id
            """,
            params)

        var out: [Int64: [Chunker.Section]] = [:]
        for row in rows {
            guard let docId = row.int("document_id"), let kind = row.text("section_kind") else {
                continue
            }
            out[docId, default: []]
                .append(
                    Chunker.Section(
                        kind: kind,
                        heading: row.text("heading"),
                        contentText: row.text("content_text")))
        }
        return out
    }
}

// IndexEmbeddings — the native per-chunk embedding index writer on the ADDB engine
// ("ADSQLv0"). The bit-faithful port of `indexEmbeddings`
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
// ── JS → ADDB faithful reproduction ───────────────────────────────────────────
//   • Chunking is `ADEmbed.Chunker.chunkDocument` (the bit-exact port of
//     src/search/chunker.js — chunk 0 is the anchor).
//   • Quantization is `ADEmbed.Quantize.signCode` / `.i8Code` (the bit-exact ports
//     of src/search/embedding.js `quantizeTo` / `quantizeI8`).
//   • The SQL is the literal JS text: the `document_chunks` upsert (chunks.js
//     `upsertStmt`), the `document_vectors` anchor upsert (index-embeddings.js
//     `anchorUpsert`), the per-doc `DELETE` (chunks.js `deleteByDocStmt`), and the
//     resume / full document scans. `INSERT OR REPLACE` is parsed by the ADDB
//     frontend (Writer `.replace`), so the upserts are verbatim.
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
//
// `public import ADDB` (`Database` is in `run`'s signature) and `public import
// ADEmbed` (`Embedder` appears in the public `ChunkEmbedder` conformance below;
// `Chunker`/`Quantize` back the implementation). `ADSQLModel` (`Value`/`DBError`)
// is used only internally — `run` throws untyped — so it is an internal import.
public import ADDB
public import ADEmbed
import ADSQLModel

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
/// open, writable ADDB `Database` whose schema is already at `AppleDocsSchema`.
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
    ///   - db: an open, writable ADDB database migrated to `AppleDocsSchema`.
    ///   - embedder: the chunk embedder (model2vec in production; a fake in tests).
    ///   - embedModel: the model id stamped into `snapshot_meta.embed_model`.
    ///   - embedVersion: the embedder behavior version (RFC 0001 §10). When set and
    ///     it differs from the stored `embed_version`, a non-`full` run upgrades to
    ///     a full re-embed (resuming would mix versions in one table). `nil` ⇒ no
    ///     version gating (mirrors the JS `embedVersion === undefined` branch).
    ///   - full: re-embed every document (else only documents with no chunks).
    ///   - batchSize: documents per embed/transaction batch (JS `BATCH` = 64).
    ///   - onProgress: invoked after each committed batch with `(done, total)`.
    /// - Returns: the run ``Result``.
    @discardableResult
    public static func run(
        _ db: Database,
        embedder: some ChunkEmbedder,
        embedModel: String = defaultModel,
        embedVersion: Int? = nil,
        full: Bool = false,
        batchSize: Int = 64,
        onProgress: ((_ done: Int, _ total: Int) -> Void)? = nil
    ) throws -> Result {
        // ── snapshot_meta helpers (single-row auto-commit each, as the JS does) ──
        func setMeta(_ key: String, _ value: String) throws(DBError) {
            try db.prepare("INSERT OR REPLACE INTO snapshot_meta (key, value) VALUES ($key, $value)")
                .run(["key": .text(key), "value": .text(value)])
        }
        func getMeta(_ key: String) throws(DBError) -> String? {
            let rows = try db.prepare("SELECT value FROM snapshot_meta WHERE key = $key")
                .all(["key": .text(key)])
            return rows.first.flatMap { cellText($0["value"]) }
        }
        func chunkCount() throws(DBError) -> Int64 {
            let rows = try db.prepare("SELECT COUNT(*) AS c FROM document_chunks").all()
            return rows.first.flatMap { cellInt($0["c"]) } ?? 0
        }

        // A deliberate embedding-behavior change (stamped as `embed_version`)
        // invalidates stored chunks wholesale — resuming would mix versions. Checked
        // BEFORE the resume scan so an "up to date" v1 store still re-embeds under v2.
        var resolvedFull = full
        if !resolvedFull, let embedVersion, try chunkCount() > 0 {
            let stored = try getMeta("embed_version") ?? "1"
            if stored != String(embedVersion) { resolvedFull = true }
        }

        // ── document scan: full (every doc) or resume (docs with no chunks) ──────
        // The JS uses `WHERE id NOT IN (SELECT document_id FROM document_chunks)`, but
        // the ADDB frontend does not support an `IN (SELECT …)` subquery, so the
        // anti-join is done in Swift: read every document (id order), then drop the
        // already-chunked ids on a resume. Same result set + order as the JS scan.
        var docRows = try db.prepare(
            "SELECT id, title, abstract_text, headings FROM documents ORDER BY id"
        ).all().compactMap(DocRow.init)
        if !resolvedFull {
            let chunked = try chunkedDocumentIds(db)
            docRows = docRows.filter { !chunked.contains($0.id) }
        }
        let total = docRows.count
        if total == 0 {
            return Result(status: "ok", indexed: 0, total: 0, chunks: 0)
        }

        // `"text"` is quoted: it is a reserved word, and the column is declared
        // `"text" BLOB` (v25). ADDB's frontend rejects the bare identifier (SQLite
        // tolerated it); quoting matches the schema and the JS column list semantically.
        let chunkUpsertSQL = """
            INSERT OR REPLACE INTO document_chunks(document_id, ord, "text", vec_bin, vec_i8)
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
                try setMeta("embed_dims", String(dims))
                try setMeta("embed_model", embedModel)
                if let embedVersion { try setMeta("embed_version", String(embedVersion)) }
            }

            try db.transaction { (txn) throws(DBError) in
                for row in batch {  // clear stale ords on re-index (per-doc dedup)
                    try txn.run(
                        "DELETE FROM document_chunks WHERE document_id = $doc",
                        ["doc": .integer(row.id)])
                }
                for index in flat.indices {
                    let chunk = flat[index]
                    let code = codes[index]
                    try txn.run(
                        chunkUpsertSQL,
                        [
                            "doc": .integer(chunk.docId),
                            "ord": .integer(Int64(chunk.ord)),
                            "text": .null,
                            "bin": .blob(code.bin),
                            "i8": .blob(code.i8),
                        ])
                    if chunk.ord == 0 {
                        try txn.run(
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

    // MARK: - reads

    /// One `documents` row feeding the chunker (the JS resume/full scan projection).
    private struct DocRow {
        let id: Int64
        let title: String?
        let abstractText: String?
        let headings: String?

        init?(_ row: SQLRow) {
            guard let id = cellInt(row["id"]) else { return nil }
            self.id = id
            self.title = cellText(row["title"])
            self.abstractText = cellText(row["abstract_text"])
            self.headings = cellText(row["headings"])
        }
    }

    /// The set of `document_id`s that already have chunks — the resume anti-join
    /// (the Swift stand-in for the JS `id NOT IN (SELECT document_id …)`).
    private static func chunkedDocumentIds(_ db: Database) throws(DBError) -> Set<Int64> {
        var ids = Set<Int64>()
        for row in try db.prepare("SELECT DISTINCT document_id FROM document_chunks").all() {
            if let id = cellInt(row["document_id"]) { ids.insert(id) }
        }
        return ids
    }

    /// Batched `document_id → [Chunker.Section]` fetch, mirroring
    /// `getSectionsByDocumentIds`: ordered by `(document_id, sort_order, id)` so the
    /// chunk order (and therefore each chunk's `ord`) is identical to the JS writer.
    /// `content_text` is read as plain text (the writer-path state at index time).
    private static func sections(
        _ db: Database, forDocumentIds ids: [Int64]
    ) throws(DBError) -> [Int64: [Chunker.Section]] {
        if ids.isEmpty { return [:] }
        var placeholders: [String] = []
        var params: [String: Value] = [:]
        placeholders.reserveCapacity(ids.count)
        for (i, id) in ids.enumerated() {
            let name = "d\(i)"
            placeholders.append("$\(name)")
            params[name] = .integer(id)
        }
        let rows = try db.prepare(
            """
            SELECT document_id, section_kind, heading, content_text, sort_order
            FROM document_sections WHERE document_id IN (\(placeholders.joined(separator: ", ")))
            ORDER BY document_id, sort_order, id
            """
        ).all(params)

        var out: [Int64: [Chunker.Section]] = [:]
        for row in rows {
            guard let docId = cellInt(row["document_id"]),
                let kind = cellText(row["section_kind"])
            else { continue }
            out[docId, default: []].append(
                Chunker.Section(
                    kind: kind,
                    heading: cellText(row["heading"]),
                    contentText: cellText(row["content_text"])))
        }
        return out
    }
}

// MARK: - SQLRow cell readers

/// Read a TEXT cell as `String?` (any non-text/NULL → nil).
private func cellText(_ value: Value?) -> String? {
    if case .text(let s) = value { return s }
    return nil
}

/// Read an INTEGER cell as `Int64?` (any non-integer/NULL → nil).
private func cellInt(_ value: Value?) -> Int64? {
    if case .integer(let i) = value { return i }
    return nil
}

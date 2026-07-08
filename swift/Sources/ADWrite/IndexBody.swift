// IndexBody — the documents_body_fts bulk indexer, the port of
// `src/pipeline/index-body.js` (`indexBodyFull` / `indexBodyIncremental` /
// `indexNormalizedBody`). The title/trigram FTS tables are TRIGGER-maintained on
// every documents write; the BODY index is the one FTS table populated by an
// explicit post-crawl pass (the JS sync's "Body index complete: N documents
// indexed" phase), because its content — the rendered plain-text body — is
// derived from `document_sections`, not from a single documents column.
//
// Faithful to the JS:
//   • full vs incremental: incremental scans `WHERE updated_at > ?` from the
//     `schema_meta.body_indexed_at` stamp; full clears the index first
//     (`clearBodyIndex` — `DELETE FROM documents_body_fts`).
//   • batches of 500 by ascending id (`WHERE id > ? ORDER BY id LIMIT ?`), each
//     batch's inserts in one transaction (`INSERT OR REPLACE INTO
//     documents_body_fts(rowid, body)` — search.js `bodyInsertStmt`).
//   • resume checkpoints in `sync_checkpoint` (key `body-index:full` /
//     `body-index:incremental`), cleared on completion; `body_indexed_at` is
//     stamped once at the end.
//   • the body text is `renderPlainText(document, sections)` — rendered through
//     `ADContent.PlainText`, the SAME renderer the JS calls natively
//     (`nativePlainTextBatch` → `ad_content_plaintext`), so the indexed bytes
//     match the JS-built index. Sections read `ORDER BY sort_order, id`;
//     zstd-compacted section blobs are inflated like `decodeSectionContent`.
//
// One documented divergence: the JS falls back to re-normalizing a document from
// its raw-json file (`ensureNormalizedDocument`) when it has NO sections rows.
// The native crawl always persists sections, so this pass renders the document
// fields alone in that case rather than reaching into the data dir.

import ADArchive
import ADContent
public import ADStorage
import Foundation

/// The documents_body_fts writer — a namespace over an open, writable SQLite
/// connection whose schema is already at `AppleDocsSchema`.
public enum IndexBody {
    /// One run's outcome (the JS `{ indexed, total, errors }` return).
    public struct Result: Sendable, Equatable {
        public let indexed: Int
        public let total: Int
        public let errors: Int
    }

    static let batchSize = 500

    /// Rebuild the whole body index from scratch (JS `indexBodyFull`).
    @discardableResult
    public static func runFull(
        _ db: SQLiteWriteConnection, now: String, onProgress: ((_ indexed: Int, _ total: Int) -> Void)? = nil
    ) throws -> Result {
        try run(db, since: nil, now: now, onProgress: onProgress)
    }

    /// Index only documents updated after the last build (JS `indexBodyIncremental`).
    @discardableResult
    public static func runIncremental(
        _ db: SQLiteWriteConnection, now: String, onProgress: ((_ indexed: Int, _ total: Int) -> Void)? = nil
    ) throws -> Result {
        let lastIndexed = try db.get(
            "SELECT value FROM schema_meta WHERE key = 'body_indexed_at'")?
            .text("value")
        return try run(db, since: lastIndexed, now: now, onProgress: onProgress)
    }

    // The JS `indexNormalizedBody` body, one loop — kept whole so the checkpoint /
    // batch / stamp sequencing reads exactly like the reference.
    // swiftlint:disable:next function_body_length cyclomatic_complexity
    static func run(
        _ db: SQLiteWriteConnection, since: String?, now: String,
        onProgress: ((_ indexed: Int, _ total: Int) -> Void)?
    ) throws -> Result {
        let checkpointKey = since != nil ? "body-index:incremental" : "body-index:full"
        let checkpoint = try readCheckpoint(db, key: checkpointKey)
        let resumeSince = checkpoint?.since ?? since
        let total: Int
        if let checkpointTotal = checkpoint?.total {
            total = checkpointTotal
        } else if let resumeSince {
            total = Int(
                try db.get(
                    "SELECT COUNT(*) AS c FROM documents WHERE updated_at > $since",
                    ["since": .text(resumeSince)])?
                    .int("c") ?? 0)
        } else {
            total = Int(try db.get("SELECT COUNT(*) AS c FROM documents")?.int("c") ?? 0)
        }

        if total == 0 {
            try clearCheckpoint(db, key: checkpointKey)
            return Result(indexed: 0, total: 0, errors: 0)
        }

        var indexed = checkpoint?.indexed ?? 0
        var errors = checkpoint?.errors ?? 0
        var lastDocumentId = checkpoint?.lastDocumentId ?? 0

        if resumeSince == nil, checkpoint == nil {
            try db.run("DELETE FROM documents_body_fts")  // clearBodyIndex
        }

        while true {
            let documents: [SQLiteRow]
            if let resumeSince {
                documents = try db.all(
                    """
                    SELECT id, key, title, abstract_text, declaration_text, headings, source_type
                    FROM documents
                    WHERE updated_at > $since AND id > $last
                    ORDER BY id
                    LIMIT $limit
                    """,
                    [
                        "since": .text(resumeSince), "last": .integer(lastDocumentId),
                        "limit": .integer(Int64(batchSize))
                    ])
            } else {
                documents = try db.all(
                    """
                    SELECT id, key, title, abstract_text, declaration_text, headings, source_type
                    FROM documents
                    WHERE id > $last
                    ORDER BY id
                    LIMIT $limit
                    """,
                    ["last": .integer(lastDocumentId), "limit": .integer(Int64(batchSize))])
            }
            if documents.isEmpty { break }

            var inserts: [(id: Int64, body: String)] = []
            for document in documents {
                guard let id = document.int("id") else { continue }
                lastDocumentId = id
                do {
                    let sections = try sectionRows(db, documentId: id)
                    let body = renderBody(document, sections: sections)
                    if !body.isEmpty {
                        inserts.append((id: id, body: body))
                        indexed += 1
                    }
                } catch {
                    errors += 1
                }
            }

            if !inserts.isEmpty {
                try db.transaction { () throws(SQLiteWriteError) in
                    for insert in inserts {
                        try db.run(
                            "INSERT OR REPLACE INTO documents_body_fts(rowid, body) VALUES ($id, $body)",
                            ["id": .integer(insert.id), "body": .text(insert.body)])
                    }
                }
            }

            try writeCheckpoint(
                db, key: checkpointKey,
                Checkpoint(
                    since: resumeSince, total: total, indexed: indexed, errors: errors,
                    lastDocumentId: lastDocumentId),
                now: now)
            onProgress?(indexed, total)
            if documents.count < batchSize { break }
        }

        try db.run(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('body_indexed_at', $now)",
            ["now": .text(now)])
        try clearCheckpoint(db, key: checkpointKey)
        return Result(indexed: indexed, total: total, errors: errors)
    }

    // MARK: - body rendering (renderPlainText through ADContent.PlainText)

    /// One section's inflated text fields + sort order.
    private struct SectionText {
        let heading: String?
        let contentText: String
        let sortOrder: Double
    }

    private static func sectionRows(
        _ db: SQLiteWriteConnection, documentId: Int64
    ) throws(SQLiteWriteError) -> [SectionText] {
        let rows = try db.all(
            """
            SELECT section_kind, heading, content_text, content_json, sort_order
            FROM document_sections
            WHERE document_id = $id
            ORDER BY sort_order, id
            """,
            ["id": .integer(documentId)])
        return rows.map { row in
            SectionText(
                heading: row.text("heading"),
                contentText: sectionContent(row["content_text"]) ?? "",
                sortOrder: Double(row.int("sort_order") ?? 0))
        }
    }

    /// `decodeSectionContent` (storage/section-codec.js): TEXT passes through; a
    /// BLOB is a zstd frame (magic 28 b5 2f fd) inflated, or plain UTF-8 bytes.
    private static func sectionContent(_ value: SQLiteValue?) -> String? {
        switch value {
            case .text(let text):
                return text
            case .blob(let bytes):
                if bytes.count >= 4, bytes[0] == 0x28, bytes[1] == 0xB5, bytes[2] == 0x2F, bytes[3] == 0xFD,
                    let inflated = ZstdDecoder.decompress(bytes)
                {
                    return String(decoding: inflated, as: UTF8.self)
                }
                return String(decoding: bytes, as: UTF8.self)
            default:
                return nil
        }
    }

    /// `renderPlainText(document, sections)` — build one contiguous UTF-8 arena for
    /// every field, then span it into `ADContent.PlainText.render` (the same
    /// renderer the JS `nativePlainTextBatch` calls through the FFI).
    private static func renderBody(_ document: SQLiteRow, sections: [SectionText]) -> String {
        var arena: [UInt8] = []
        func stage(_ text: String?) -> Range<Int>? {
            guard let text, !text.isEmpty else { return nil }
            let start = arena.count
            arena.append(contentsOf: text.utf8)
            return start ..< arena.count
        }
        let fieldRanges = [
            stage(document.text("title")), stage(document.text("abstract_text")),
            stage(document.text("declaration_text")), stage(document.text("headings"))
        ]
        let sectionRanges = sections.map { (heading: stage($0.heading), text: stage($0.contentText)) }
        if arena.isEmpty { return "" }

        var out: [UInt8] = []
        arena.withUnsafeBytes { raw in
            func span(_ range: Range<Int>?) -> ByteSpan? {
                range.map { UnsafeRawBufferPointer(rebasing: raw[$0]) }
            }
            let doc = PlainTextSpans(
                title: span(fieldRanges[0]), abstractText: span(fieldRanges[1]),
                declarationText: span(fieldRanges[2]), headings: span(fieldRanges[3]))
            let empty = UnsafeRawBufferPointer(rebasing: raw[0 ..< 0])
            let spans = sectionRanges.enumerated()
                .map { index, ranges in
                    PlainSectionSpans(
                        heading: span(ranges.heading), text: span(ranges.text) ?? empty,
                        sortOrder: sections[index].sortOrder)
                }
            var writer = ByteWriter(capacity: 2048)
            PlainText.render(document: doc, sections: spans, w: &writer, out: &out)
        }
        return String(decoding: out, as: UTF8.self)
    }

    // MARK: - sync_checkpoint (operations.js get/set/clearSyncCheckpoint)

    private struct Checkpoint {
        var since: String?
        var total: Int
        var indexed: Int
        var errors: Int
        var lastDocumentId: Int64
    }

    private static func readCheckpoint(
        _ db: SQLiteWriteConnection, key: String
    ) throws(SQLiteWriteError) -> Checkpoint? {
        guard
            let value = try db.get(
                "SELECT value FROM sync_checkpoint WHERE key = $key", ["key": .text(key)])?
                .text("value"),
            let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any]
        else { return nil }
        return Checkpoint(
            since: object["since"] as? String,
            total: (object["total"] as? NSNumber)?.intValue ?? 0,
            indexed: (object["indexed"] as? NSNumber)?.intValue ?? 0,
            errors: (object["errors"] as? NSNumber)?.intValue ?? 0,
            lastDocumentId: (object["lastDocumentId"] as? NSNumber)?.int64Value ?? 0)
    }

    private static func writeCheckpoint(
        _ db: SQLiteWriteConnection, key: String, _ checkpoint: Checkpoint, now: String
    ) throws(SQLiteWriteError) {
        var object: [String: Any] = [
            "total": checkpoint.total, "indexed": checkpoint.indexed, "errors": checkpoint.errors,
            "lastDocumentId": checkpoint.lastDocumentId
        ]
        if let since = checkpoint.since { object["since"] = since }
        let serialized =
            (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
            .map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        try db.run(
            "INSERT OR REPLACE INTO sync_checkpoint (key, value, updated_at) VALUES ($key, $value, $now)",
            ["key": .text(key), "value": .text(serialized), "now": .text(now)])
    }

    private static func clearCheckpoint(_ db: SQLiteWriteConnection, key: String) throws(SQLiteWriteError) {
        try db.run("DELETE FROM sync_checkpoint WHERE key = $key", ["key": .text(key)])
    }
}

// The documents_body_fts WRITER gate for IndexBody (the native port of
// src/pipeline/index-body.js). Inputs are written through the REAL persist
// (`CrawlPersist.persistNormalized`) so the documents + `document_sections` the
// indexer reads are exactly what the crawl writes. Proves:
//
//   • a full build renders every document's plain-text body (title + abstract +
//     declaration + headings + sections, the renderPlainText shape) into
//     documents_body_fts, keyed by the document rowid, and stamps
//     `schema_meta.body_indexed_at`;
//   • FTS MATCH over section prose hits (the body tier's whole point);
//   • the incremental pass indexes ONLY documents updated after the stamp, and
//     a second incremental run with nothing new indexes 0.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("IndexBody — documents_body_fts bulk indexer")
struct IndexBodyTests {
    private func scratchDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-indexbody-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func doc(key: String, body: String) -> NormalizedDoc {
        NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: key, title: "Title of \(key)",
                url: "https://developer.apple.com/documentation/\(key)",
                abstractText: "An abstract.", headings: "Overview"),
            sections: [
                NormalizedSection(
                    sectionKind: "discussion", heading: "Discussion", contentText: body, sortOrder: 0)
            ],
            relationships: [])
    }

    private func persist(
        _ db: SQLiteWriteConnection, rootId: Int64, key: String, body: String, now: String
    ) throws {
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/documentation/\(key)", doc(key: key, body: body),
            hashes: .init(content: "c-\(key)-\(now)", rawPayload: "r-\(key)-\(now)"), now: now)
    }

    @Test("full build indexes every document body; incremental picks up only newer updates")
    func fullThenIncremental() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try SQLiteWriteConnection(path: dir.appendingPathComponent("body.db").path)
        defer { db.close() }
        try migrateSchema(db)

        let now1 = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swiftui", displayName: "SwiftUI", kind: "framework", source: "seed", now: now1)
        try persist(db, rootId: rootId, key: "swiftui/view", body: "prose about composable views", now: now1)
        try persist(db, rootId: rootId, key: "swiftui/text", body: "prose about glyph rendering", now: now1)

        let full = try IndexBody.runFull(db, now: now1)
        #expect(full.indexed == 2)
        #expect(full.total == 2)
        #expect(full.errors == 0)

        // The body rows live under the documents rowid and MATCH section prose.
        let rows = try db.get("SELECT COUNT(*) AS c FROM documents_body_fts")?.int("c")
        #expect(rows == 2)
        let hit = try db.get(
            "SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'composable'")?
            .int("rowid")
        let viewId = try db.get(
            "SELECT id FROM documents WHERE key = 'swiftui/view'")?
            .int("id")
        #expect(hit != nil && hit == viewId)

        // The rendered body carries the renderPlainText part order (document
        // fields, then sections with heading-joined text).
        let body = try db.get(
            "SELECT body FROM documents_body_fts WHERE rowid = $id",
            ["id": .integer(viewId ?? -1)])?
            .text("body")
        #expect(
            body
                == "Title of swiftui/view\n\nAn abstract.\n\nOverview\n\n"
                + "Discussion\nprose about composable views")

        // body_indexed_at stamped with the run's `now`.
        let stamp = try db.get(
            "SELECT value FROM schema_meta WHERE key = 'body_indexed_at'")?
            .text("value")
        #expect(stamp == now1)

        // Incremental: one NEW document persisted after the stamp is the only one
        // re-rendered; the two originals are untouched.
        let now2 = "2026-06-21T00:00:00.000Z"
        try persist(db, rootId: rootId, key: "swiftui/stack", body: "prose about stacked layout", now: now2)
        let incremental = try IndexBody.runIncremental(db, now: now2)
        #expect(incremental.indexed == 1)
        #expect(incremental.total == 1)
        let after = try db.get("SELECT COUNT(*) AS c FROM documents_body_fts")?.int("c")
        #expect(after == 3)

        // Nothing newer than the second stamp → a no-op incremental run.
        let idle = try IndexBody.runIncremental(db, now: "2026-06-22T00:00:00.000Z")
        #expect(idle.indexed == 0)
        #expect(idle.total == 0)
    }
}

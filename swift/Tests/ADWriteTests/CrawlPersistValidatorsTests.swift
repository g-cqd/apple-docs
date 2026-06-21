// Gate for the incremental-re-crawl validators (Workstream 1): the `etag`/`last_modified` threaded
// through `CrawlPersist.persistNormalized` → `insertPageRow`, and read back via `pageValidator`. Proves
// (1) a persisted etag lands in `pages.etag`, (2) `pageValidator` projects it, (3) a later persist with a
// `nil` etag is COALESCE-preserved (the ON CONFLICT(path) keeps the prior validator rather than clobbering
// it to NULL), and (4) a non-nil etag on re-persist updates it. This is the storage half of the request-
// skipping re-crawl — the driver (ADBuilderPipeline) reads `pageValidator` back to drive a conditional check.

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADWrite

@Suite("CrawlPersist incremental validators (etag / last_modified)")
struct CrawlPersistValidatorsTests {
    /// Open a fresh migrated ADDB in a throwaway dir and upsert a root; returns the db + its rootId.
    private func freshDatabase(
        _ dir: URL, slug: String = "test", now: String
    ) throws -> (db: Database, rootId: Int64) {
        let db = try Database.open(
            at: dir.appendingPathComponent("validators.adsql").path, options: DatabaseOptions())
        try migrateSchema(db)
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: slug, displayName: "Test", kind: "collection", source: slug, now: now)
        return (db, rootId)
    }

    private func doc(key: String, url: String) -> NormalizedDoc {
        NormalizedDoc(
            document: NormalizedDocument(sourceType: "swift-org", key: key, title: "T", url: url),
            sections: [], relationships: [])
    }

    @Test("a persisted etag/last_modified lands in pages and reads back via pageValidator")
    func persistsAndReadsBackValidators() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-validators-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let now = "2026-06-20T00:00:00.000Z"
        let (db, rootId) = try freshDatabase(dir, now: now)
        defer { db.close() }

        // No row yet → no validator.
        #expect(try CrawlPersist.pageValidator(db, path: "/test/page") == nil)

        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/test/page", doc(key: "test/page", url: "/test/page"),
            hashes: .init(content: "c1", rawPayload: "r1"),
            etag: "\"etag-v1\"", lastModified: "Mon, 01 Jan 2026 00:00:00 GMT", now: now)

        let validator = try CrawlPersist.pageValidator(db, path: "/test/page")
        #expect(validator?.etag == "\"etag-v1\"")
        #expect(validator?.lastModified == "Mon, 01 Jan 2026 00:00:00 GMT")
    }

    @Test("re-persist with nil validators preserves the prior etag via COALESCE")
    func nilValidatorsArePreserved() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-validators-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let now = "2026-06-20T00:00:00.000Z"
        let (db, rootId) = try freshDatabase(dir, now: now)
        defer { db.close() }

        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/test/page", doc(key: "test/page", url: "/test/page"),
            hashes: .init(content: "c1", rawPayload: "r1"), etag: "\"etag-v1\"", now: now)

        // The flat re-persist (no validators) must NOT clobber the stored etag to NULL.
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/test/page", doc(key: "test/page", url: "/test/page"),
            hashes: .init(content: "c2", rawPayload: "r2"), etag: nil, lastModified: nil, now: now)

        #expect(try CrawlPersist.pageValidator(db, path: "/test/page")?.etag == "\"etag-v1\"")

        // A NEW non-nil etag on re-persist DOES update it.
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: "/test/page", doc(key: "test/page", url: "/test/page"),
            hashes: .init(content: "c3", rawPayload: "r3"), etag: "\"etag-v2\"", now: now)

        #expect(try CrawlPersist.pageValidator(db, path: "/test/page")?.etag == "\"etag-v2\"")
    }
}

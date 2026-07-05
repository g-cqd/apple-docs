// Gate for `CrawlPersist.getPendingCrawlAny`'s root-slug scoping (RFC 0007 §11 finding #2 fix): a
// `.crawl`-mode source's frontier pull must only ever surface `pending` rows under root slugs THIS CALL
// owns, never a different source's leftover backlog (an interrupted earlier crawl's `pending` rows,
// vacuumed up by whichever unrelated source ran next and mis-attributed via its own `rootIds[slug] ??
// rootId` persist fallback). Exercises the query directly (no CrawlDriver/HTTP machinery), so the storage
// boundary is pinned at its own layer rather than only observed end-to-end.

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADWrite

@Suite("CrawlPersist.getPendingCrawlAny root-slug scoping")
struct CrawlPersistPendingCrawlTests {
    private func freshDatabase(_ dir: URL) throws -> Database {
        let db = try Database.open(
            at: dir.appendingPathComponent("pending.adsql").path, options: DatabaseOptions())
        try migrateSchema(db)
        return db
    }

    private func scratchDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-pending-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("only rows whose root_slug is in the filter set are returned")
    func filtersToOwnedRootSlugsOnly() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        try CrawlPersist.setCrawlState(db, path: "a/1", status: "pending", rootSlug: "a")
        try CrawlPersist.setCrawlState(db, path: "b/1", status: "pending", rootSlug: "b")
        // A different source's own root — must never surface for a caller that only owns a/b.
        try CrawlPersist.setCrawlState(db, path: "c/1", status: "pending", rootSlug: "c")

        let rows = try CrawlPersist.getPendingCrawlAny(db, rootSlugs: ["a", "b"], limit: 10)
        var paths: Set<String> = []
        for row in rows { paths.insert(row.path) }
        #expect(paths == ["a/1", "b/1"])
    }

    @Test("an empty rootSlugs filter returns nothing rather than falling back to unfiltered")
    func emptyFilterReturnsNoRows() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        try CrawlPersist.setCrawlState(db, path: "a/1", status: "pending", rootSlug: "a")

        let rows = try CrawlPersist.getPendingCrawlAny(db, rootSlugs: [], limit: 10)
        #expect(rows.isEmpty)
    }

    @Test("processed/failed rows are excluded regardless of root_slug membership")
    func onlyPendingStatusSurfaces() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        try CrawlPersist.setCrawlState(db, path: "a/1", status: "pending", rootSlug: "a")
        try CrawlPersist.setCrawlState(db, path: "a/2", status: "processed", rootSlug: "a")
        try CrawlPersist.setCrawlState(db, path: "a/3", status: "failed", rootSlug: "a")

        let rows = try CrawlPersist.getPendingCrawlAny(db, rootSlugs: ["a"], limit: 10)
        #expect(rows.count == 1)
        #expect(rows.first?.path == "a/1")
    }

    @Test("a large rootSlugs set (apple-docc-scale multi-root pooling) still returns every owned row")
    func manyRootSlugsStillPoolTogether() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        // A source with 400 of its own roots, one pending row each — proves the `IN (…)` placeholder-per-
        // value discipline scales to an apple-docc-sized root set without truncation.
        var slugs: Set<String> = []
        for index in 0 ..< 400 {
            let slug = "root\(index)"
            slugs.insert(slug)
            try CrawlPersist.setCrawlState(db, path: "\(slug)/seed", status: "pending", rootSlug: slug)
        }
        // A foreign leftover under a slug NOT among the 400 owned roots.
        try CrawlPersist.setCrawlState(db, path: "foreign/leftover", status: "pending", rootSlug: "foreign")

        let rows = try CrawlPersist.getPendingCrawlAny(db, rootSlugs: slugs, limit: 1000)
        #expect(rows.count == 400)
        var sawForeign = false
        for row in rows where row.rootSlug == "foreign" { sawForeign = true }
        #expect(!sawForeign)
    }
}

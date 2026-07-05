// Gate for RepairPageRootIds — the RFC 0007 §11 finding #2 one-time repair: re-derive
// `pages.root_id` from `crawl_state.root_slug` (primary) or `documents.framework` (fallback for a flat
// source with no crawl_state row), correlating a page to its `documents` row via `documents.url ==
// pages.path` (verified against the real corpus — NOT `documents.key`, which is the bare crawl key,
// unrelated to `pages.path`'s external-URL form). Exercises `RepairPageRootIds.run` directly against a
// small synthetic ADDB corpus (no CrawlDriver/HTTP machinery).

import ADDB
import ADSQLModel
import Foundation
import Testing

@testable import ADWrite

@Suite("RepairPageRootIds — RFC 0007 §11 finding #2 one-time root_id repair")
struct RepairPageRootIdsTests {
    private func freshDatabase(_ dir: URL) throws -> Database {
        let db = try Database.open(
            at: dir.appendingPathComponent("repair.adsql").path, options: DatabaseOptions())
        try migrateSchema(db)
        return db
    }

    private func scratchDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adwrite-repair-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func doc(key: String, url: String, framework: String?) -> NormalizedDoc {
        NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: key, title: key, framework: framework, url: url),
            sections: [], relationships: [])
    }

    private func rootIdOf(_ db: Database, path: String) throws -> Int64? {
        let rows = try db.prepare("SELECT root_id AS r FROM pages WHERE path = $p").all(["p": .text(path)])
        guard case .integer(let rootId)? = rows.first?["r"] else { return nil }
        return rootId
    }

    @Test("crawl_state.root_slug wins over a DISAGREEING documents.framework")
    func crawlStateTakesPriorityOverFramework() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)
        let rightId = try CrawlPersist.upsertRoot(
            db, slug: "right", displayName: "Right", kind: "collection", source: "test", now: now)
        _ = try CrawlPersist.upsertRoot(
            db, slug: "framework-slug", displayName: "FrameworkSlug", kind: "collection", source: "test",
            now: now)

        // Mis-attributed: persisted under `wrongId`. Its documents.framework says "framework-slug", but
        // its crawl_state.root_slug says "right" — the two DISAGREE, and crawl_state must win.
        let path = "https://example.com/right/page"
        try CrawlPersist.persistNormalized(
            db, rootId: wrongId, path: path,
            doc(key: "right/page", url: path, framework: "framework-slug"),
            hashes: .init(content: "c", rawPayload: "r"), now: now)
        try CrawlPersist.setCrawlState(db, path: "right/page", status: "processed", rootSlug: "right")

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.examined == 1)
        #expect(result.changed == 1)
        #expect(result.alreadyCorrect == 0)
        #expect(result.unresolved == 0)
        #expect(try rootIdOf(db, path: path) == rightId)
    }

    @Test("documents.framework resolves a FLAT source's page (no crawl_state row at all)")
    func frameworkFallbackResolvesAFlatSourcePage() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)
        let flatId = try CrawlPersist.upsertRoot(
            db, slug: "swift-evolution", displayName: "Swift Evolution", kind: "collection", source: "test",
            now: now)

        // A flat-source page: NO crawl_state row (swift-evolution never touches crawl_state), only
        // documents.framework to resolve by.
        let path = "https://github.com/swiftlang/swift-evolution/blob/main/proposals/0001-x.md"
        try CrawlPersist.persistNormalized(
            db, rootId: wrongId, path: path,
            doc(key: "swift-evolution/0001-x", url: path, framework: "swift-evolution"),
            hashes: .init(content: "c", rawPayload: "r"), now: now)

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.changed == 1)
        #expect(result.unresolved == 0)
        #expect(try rootIdOf(db, path: path) == flatId)
    }

    @Test("a page whose root_id is already correct is left untouched")
    func alreadyCorrectPageIsNotRewritten() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let rightId = try CrawlPersist.upsertRoot(
            db, slug: "right", displayName: "Right", kind: "collection", source: "test", now: now)

        let path = "https://example.com/right/page"
        try CrawlPersist.persistNormalized(
            db, rootId: rightId, path: path,
            doc(key: "right/page", url: path, framework: "right"),
            hashes: .init(content: "c", rawPayload: "r"), now: now)
        try CrawlPersist.setCrawlState(db, path: "right/page", status: "processed", rootSlug: "right")

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.changed == 0)
        #expect(result.alreadyCorrect == 1)
        #expect(result.unresolved == 0)
        #expect(try rootIdOf(db, path: path) == rightId)
    }

    @Test("a resolved slug matching no known root is left unresolved, never guessed")
    func unknownSlugIsUnresolved() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)

        let path = "https://example.com/ghost/page"
        try CrawlPersist.persistNormalized(
            db, rootId: wrongId, path: path,
            doc(key: "ghost/page", url: path, framework: "ghost"),
            hashes: .init(content: "c", rawPayload: "r"), now: now)
        // "ghost" matches no roots.slug row at all — a page this can't confidently resolve.

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.changed == 0)
        #expect(result.unresolved == 1)
        #expect(result.unresolvedSamples == [path])
        // Left untouched — never guessed at a fallback root.
        #expect(try rootIdOf(db, path: path) == wrongId)
    }

    @Test("a page with no crawl_state row and a nil framework is unresolved")
    func noSignalAtAllIsUnresolved() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)

        let path = "https://example.com/nosignal/page"
        try CrawlPersist.persistNormalized(
            db, rootId: wrongId, path: path,
            doc(key: "nosignal/page", url: path, framework: nil),
            hashes: .init(content: "c", rawPayload: "r"), now: now)

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.unresolved == 1)
        #expect(try rootIdOf(db, path: path) == wrongId)
    }

    @Test("many pages moving to DIFFERENT target roots in one pass all resolve correctly")
    func multipleTargetRootsInOnePassAllResolveCorrectly() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)
        let alphaId = try CrawlPersist.upsertRoot(
            db, slug: "alpha", displayName: "Alpha", kind: "collection", source: "test", now: now)
        let betaId = try CrawlPersist.upsertRoot(
            db, slug: "beta", displayName: "Beta", kind: "collection", source: "test", now: now)

        // Two pages per target root, all currently mis-attributed to `wrongId` — small batchSize (2)
        // forces multiple chunks per target root, exercising the chunk-loop as well as the grouping.
        for index in 0 ..< 2 {
            let path = "https://example.com/alpha/page\(index)"
            try CrawlPersist.persistNormalized(
                db, rootId: wrongId, path: path,
                doc(key: "alpha/page\(index)", url: path, framework: "alpha"),
                hashes: .init(content: "c", rawPayload: "r"), now: now)
        }
        for index in 0 ..< 2 {
            let path = "https://example.com/beta/page\(index)"
            try CrawlPersist.persistNormalized(
                db, rootId: wrongId, path: path,
                doc(key: "beta/page\(index)", url: path, framework: "beta"),
                hashes: .init(content: "c", rawPayload: "r"), now: now)
        }

        let result = try RepairPageRootIds.run(db, batchSize: 2)
        #expect(result.examined == 4)
        #expect(result.changed == 4)
        #expect(result.unresolved == 0)

        for index in 0 ..< 2 {
            #expect(try rootIdOf(db, path: "https://example.com/alpha/page\(index)") == alphaId)
            #expect(try rootIdOf(db, path: "https://example.com/beta/page\(index)") == betaId)
        }
    }

    @Test("only active pages are examined; an inactive page is never touched")
    func inactivePagesAreNotExamined() throws {
        let dir = try scratchDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir)
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let wrongId = try CrawlPersist.upsertRoot(
            db, slug: "wrong", displayName: "Wrong", kind: "collection", source: "test", now: now)
        _ = try CrawlPersist.upsertRoot(
            db, slug: "right", displayName: "Right", kind: "collection", source: "test", now: now)

        let path = "https://example.com/right/inactive"
        try CrawlPersist.persistNormalized(
            db, rootId: wrongId, path: path,
            doc(key: "right/inactive", url: path, framework: "right"),
            hashes: .init(content: "c", rawPayload: "r"), now: now)
        try db.transaction { (txn) throws(DBError) in
            _ = try txn.run("UPDATE pages SET status = 'deleted' WHERE path = $p", ["p": .text(path)])
        }

        let result = try RepairPageRootIds.run(db, batchSize: 10)
        #expect(result.examined == 0)
        #expect(result.changed == 0)
        // Untouched: still under the "wrong" root, since it was never examined at all.
        #expect(try rootIdOf(db, path: path) == wrongId)
    }
}

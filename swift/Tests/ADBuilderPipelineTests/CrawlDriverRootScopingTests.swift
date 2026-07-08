// Gate for the RFC 0007 §11 finding #2 fix: `CrawlDriver.crawlFrontier`'s frontier pull
// (`CrawlPersist.getPendingCrawlAny`) must only ever drain `pending` `crawl_state` rows belonging to
// the CALLING crawl's own root set — never a different source's leftover backlog (an interrupted
// earlier crawl, e.g. this corpus's own apple-docc history) — while still pooling a legitimate
// multi-root source's OWN roots into one frontier, exactly as before the fix. Split out of
// `CrawlDriverTests.swift` to stay under the file's `type_body_length` budget (matching
// `CrawlDriverIncrementalTests.swift`'s own precedent for splitting a growing suite).

import ADBuilder
import ADStorage
import ADWrite
import Foundation
import HTTPTypes
import Testing

@testable import ADBuilderPipeline

struct CrawlDriverRootScopingTests {
    private struct StubClient: HTTPClient {
        func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
            HTTPClientResponse(status: .init(code: 200), headerFields: [:], body: ResponseBody(buffered: []))
        }
    }

    private func context() -> SourceContext {
        SourceContext(client: StubClient(), rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))
    }

    private func freshDatabase(_ dir: URL, name: String) throws -> SQLiteWriteConnection {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let db = try SQLiteWriteConnection(path: dir.appendingPathComponent(name).path)
        _ = try migrateSchema(db)
        return db
    }

    /// A minimal `.crawl` adapter with exactly one seed key and no further references — used to prove
    /// `crawlFrontier`'s frontier pull never touches a `pending` row seeded by a DIFFERENT source (RFC 0007
    /// §11 finding #2: an interrupted source's backlog getting vacuumed up by whichever `.crawl` source ran
    /// next and mis-attributed via `rootIds[f.rootSlug] ?? rootId`).
    private struct SingleSeedCrawlAdapter: SourceAdapter {
        static let type = "singleseed"
        static let displayName = "SingleSeed"
        static let syncMode = SyncMode.crawl
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(
                keys: ["aroot/seed"],
                roots: [DiscoveredRoot(slug: "aroot", displayName: "ARoot", kind: "collection", source: Self.type)])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            // Only this source's own seed key is ever fetchable — any OTHER key reaching `fetch` would
            // mean a foreign root's pending row leaked into this source's frontier.
            guard key == "aroot/seed" else { throw AdapterError.unexpectedPayload("unexpected key: \(key)") }
            return FetchResult(key: key, payload: .html("<main><h1>\(key)</h1><p>body</p></main>"))
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .modified, changed: true) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            guard case .html(let html) = payload else { throw AdapterError.unexpectedPayload("html") }
            return HtmlNormalize.parse(
                html, key: key, sourceType: Self.type, kind: "article", framework: Self.type,
                url: "https://singleseed/\(key)")
        }
    }

    @Test func crawlFrontierNeverDrainsAForeignSourcesPendingBacklog() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlforeign-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir, name: "foreign.db")
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let aRootId = try CrawlPersist.upsertRoot(
            db, slug: "aroot", displayName: "ARoot", kind: "collection", source: "singleseed", now: now)

        // Simulate a DIFFERENT source's interrupted crawl: a `pending` crawl_state row under a root slug
        // ("foreign") this call's `rootIds` never mentions — exactly what an earlier apple-docc run leaves
        // behind when interrupted mid-crawl.
        try CrawlPersist.setCrawlState(db, path: "foreign/orphan", status: "pending", rootSlug: "foreign")

        let driver = CrawlDriver(registry: SourceRegistry([SingleSeedCrawlAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "singleseed", into: db, rootId: aRootId, rootIds: ["aroot": aRootId],
            context: context(), now: now)

        // Only this source's own seed was fetched/persisted — the foreign backlog was never touched.
        #expect(stats.persisted == 1)
        #expect(stats.failed == 0)

        let own = try CrawlPersist.getCrawlStats(db, rootSlug: "aroot")
        #expect(own.pending == 0 && own.processed == 1 && own.failed == 0)

        // The foreign root's pending row is untouched: still pending, never drained into this crawl.
        let foreign = try CrawlPersist.getCrawlStats(db, rootSlug: "foreign")
        #expect(foreign.pending == 1 && foreign.processed == 0 && foreign.failed == 0)

        // And no page was ever persisted for it (never fetched, let alone mis-attributed).
        let count = try db.get("SELECT COUNT(*) AS c FROM pages")?.int("c")
        #expect(count == 1)
    }

    /// A multi-root `.crawl` adapter: two roots ("m1"/"m2"), each with one seed key and one same-root
    /// follow-up ref — proves the fix preserves pooling ALL of a source's OWN roots into one frontier (only
    /// a DIFFERENT source's backlog must be excluded, not a legitimate sibling root of the SAME call).
    private struct MultiRootCrawlAdapter: SourceAdapter {
        static let type = "multicrawl"
        static let displayName = "MultiCrawl"
        static let syncMode = SyncMode.crawl
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(
                keys: ["m1/seed", "m2/seed"],
                roots: [
                    DiscoveredRoot(slug: "m1", displayName: "M1", kind: "collection", source: Self.type),
                    DiscoveredRoot(slug: "m2", displayName: "M2", kind: "collection", source: Self.type)
                ])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            FetchResult(key: key, payload: .html("<main><h1>\(key)</h1><p>body</p></main>"))
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .modified, changed: true) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            guard case .html(let html) = payload else { throw AdapterError.unexpectedPayload("html") }
            return HtmlNormalize.parse(
                html, key: key, sourceType: Self.type, kind: "article", framework: Self.type,
                url: "https://multicrawl/\(key)")
        }
        func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
            switch key {
                case "m1/seed": return ["m1/child"]
                case "m2/seed": return ["m2/child"]
                default: return []
            }
        }
    }

    @Test func crawlFrontierPoolsAllOfOneSourcesOwnRootsTogether() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlmultibfs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try freshDatabase(dir, name: "multibfs.db")
        defer { db.close() }

        let now = "2026-06-20T00:00:00.000Z"
        let m1Id = try CrawlPersist.upsertRoot(
            db, slug: "m1", displayName: "M1", kind: "collection", source: "multicrawl", now: now)
        let m2Id = try CrawlPersist.upsertRoot(
            db, slug: "m2", displayName: "M2", kind: "collection", source: "multicrawl", now: now)

        let driver = CrawlDriver(registry: SourceRegistry([MultiRootCrawlAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "multicrawl", into: db, rootId: m1Id, rootIds: ["m1": m1Id, "m2": m2Id],
            context: context(), now: now)

        // Both roots' seeds AND their same-root follow-ups drained: m1/seed, m1/child, m2/seed, m2/child.
        #expect(stats.persisted == 4)
        #expect(stats.failed == 0)

        let m1Stats = try CrawlPersist.getCrawlStats(db, rootSlug: "m1")
        #expect(m1Stats.pending == 0 && m1Stats.processed == 2)
        let m2Stats = try CrawlPersist.getCrawlStats(db, rootSlug: "m2")
        #expect(m2Stats.pending == 0 && m2Stats.processed == 2)

        // Each page attributed to its own root.
        let rows = try db.all("SELECT root_id AS r, COUNT(*) AS c FROM pages GROUP BY root_id")
        var byRoot: [Int64: Int] = [:]
        for row in rows {
            guard let r = row.int("r"), let c = row.int("c") else { continue }
            byRoot[r] = Int(c)
        }
        #expect(byRoot[m1Id] == 2)
        #expect(byRoot[m2Id] == 2)
    }
}

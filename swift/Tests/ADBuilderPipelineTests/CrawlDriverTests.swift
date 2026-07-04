// Gate for CrawlDriver — the full source-agnostic crawl loop end-to-end: registry → discover →
// fetch (stub transport) → normalize (ADHTML) → persist (CrawlPipeline) into a fresh migrated ADDB,
// asserting the stats and that one documents row landed per discovered key.

import ADBuilder
import ADDB
import ADSQLModel
import ADWrite
import Foundation
import HTTPTypes
import Testing

@testable import ADBuilderPipeline

struct CrawlDriverTests {
    private struct StubClient: HTTPClient {
        let respond: @Sendable (HTTPClientRequest) -> HTTPClientResponse
        func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse { respond(request) }
    }

    @Test func crawlsSwiftOrgEndToEndIntoDatabase() async throws {
        let html = """
            <html><head><title>Page | Swift.org</title></head>
            <body><main><h1>Page</h1><p>body text.</p></main></body></html>
            """
        let context = SourceContext(
            client: StubClient { _ in
                HTTPClientResponse(
                    status: .init(code: 200), headerFields: [:],
                    body: ResponseBody(buffered: Array(html.utf8)))
            },
            rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawldriver-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(
            at: dir.appendingPathComponent("crawl.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swift-org", displayName: "Swift.org", kind: "collection", source: "swift-org",
            now: now)

        let driver = CrawlDriver(registry: SourceRegistry([SwiftOrgAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "swift-org", into: db, rootId: rootId, context: context, now: now)

        #expect(stats.discovered > 50)  // the curated swift.org path list
        #expect(stats.persisted == stats.discovered)
        #expect(stats.failed == 0)

        let rows = try db.prepare("SELECT COUNT(*) AS c FROM documents").all([:])
        guard case .integer(let count) = rows.first?["c"] else {
            Issue.record("no count row")
            return
        }
        #expect(Int(count) == stats.persisted)
    }

    /// A deterministic unit-norm fake embedder (no model dependency).
    private struct FakeEmbedder: ChunkEmbedder {
        let dims = 8
        func embed(_ text: String) throws -> [Float] {
            var vector = [Float](repeating: 0, count: dims)
            for (index, byte) in text.utf8.enumerated() { vector[index % dims] += Float(byte) }
            let norm = vector.reduce(Float(0)) { $0 + $1 * $1 }.squareRoot()
            return norm > 0 ? vector.map { $0 / norm } : vector
        }
    }

    @Test func syncCrawlsThenIndexesForSearch() async throws {
        let html = """
            <html><head><title>Page | Swift.org</title></head>
            <body><main><h1>Page</h1><p>body text for indexing.</p></main></body></html>
            """
        let context = SourceContext(
            client: StubClient { _ in
                HTTPClientResponse(
                    status: .init(code: 200), headerFields: [:],
                    body: ResponseBody(buffered: Array(html.utf8)))
            },
            rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlsync-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(
            at: dir.appendingPathComponent("sync.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swift-org", displayName: "Swift.org", kind: "collection", source: "swift-org",
            now: now)

        let driver = CrawlDriver(registry: SourceRegistry([SwiftOrgAdapter.self]))
        let result = try await driver.sync(
            sourceType: "swift-org", into: db, rootId: rootId, context: context, now: now,
            embedder: FakeEmbedder())

        #expect(result.crawl.persisted == result.crawl.discovered)
        #expect(result.index.status == "ok")
        #expect(result.index.indexed == result.crawl.persisted)
        #expect(result.index.chunks > 0)

        let rows = try db.prepare("SELECT COUNT(*) AS c FROM document_chunks").all([:])
        guard case .integer(let chunkCount) = rows.first?["c"] else {
            Issue.record("no chunk count")
            return
        }
        #expect(Int(chunkCount) == result.index.chunks)
    }

    private actor ConcurrencyTracker {
        private(set) var peak = 0
        private var current = 0
        func enter() {
            current += 1
            peak = Swift.max(peak, current)
        }
        func leave() { current -= 1 }
    }

    /// A transport that records peak in-flight `send`s while holding each briefly.
    private struct SlowClient: HTTPClient {
        let tracker: ConcurrencyTracker
        let body: [UInt8]
        func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
            await tracker.enter()
            try? await Task.sleep(for: .milliseconds(10))
            await tracker.leave()
            return HTTPClientResponse(
                status: .init(code: 200), headerFields: [:], body: ResponseBody(buffered: body))
        }
    }

    @Test func crawlBoundsConcurrency() async throws {
        let tracker = ConcurrencyTracker()
        let context = SourceContext(
            client: SlowClient(tracker: tracker, body: Array("<main><h1>P</h1><p>x</p></main>".utf8)),
            rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlconc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(
            at: dir.appendingPathComponent("c.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swift-org", displayName: "Swift.org", kind: "collection", source: "swift-org",
            now: now)

        let driver = CrawlDriver(registry: SourceRegistry([SwiftOrgAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "swift-org", into: db, rootId: rootId, context: context, now: now,
            maxConcurrency: 4)

        #expect(stats.persisted == stats.discovered)
        let peak = await tracker.peak
        #expect(peak > 1)  // genuinely concurrent
        #expect(peak <= 4)  // bounded by maxConcurrency
    }

    /// An adapter whose `fetch` throws for keys ending in `bad` — to exercise the per-key failure path.
    private struct FlakyAdapter: SourceAdapter {
        static let type = "flaky"
        static let displayName = "Flaky"
        init() {}
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: ["flaky/ok1", "flaky/bad", "flaky/ok2"])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            if key.hasSuffix("bad") { throw AdapterError.unexpectedPayload("boom: \(key)") }
            return FetchResult(key: key, payload: .html("<main><h1>\(key)</h1><p>body</p></main>"))
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .modified, changed: true) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            guard case .html(let html) = payload else { throw AdapterError.unexpectedPayload("html") }
            return HtmlNormalize.parse(
                html, key: key, sourceType: Self.type, kind: "article", framework: Self.type,
                url: "https://flaky/\(key)")
        }
    }

    @Test func perKeyFailuresAreCountedNotFatal() async throws {
        let context = SourceContext(
            client: StubClient { _ in
                HTTPClientResponse(status: .init(code: 200), headerFields: [:], body: ResponseBody(buffered: []))
            },
            rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlflaky-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(
            at: dir.appendingPathComponent("f.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "flaky", displayName: "Flaky", kind: "collection", source: "flaky", now: now)

        let driver = CrawlDriver(registry: SourceRegistry([FlakyAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "flaky", into: db, rootId: rootId, context: context, now: now)

        #expect(stats.discovered == 3)
        #expect(stats.persisted == 2)  // ok1 + ok2
        #expect(stats.failed == 1)  // bad — counted, not fatal
    }

    /// A multi-root flat source: keys under two root slugs (`alpha/…`, `beta/…`), two discovered roots.
    private struct MultiRootAdapter: SourceAdapter {
        static let type = "multiroot"
        static let displayName = "MultiRoot"
        init() {}
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(
                keys: ["alpha/one", "alpha/two", "beta/one"],
                roots: [
                    DiscoveredRoot(slug: "alpha", displayName: "Alpha", kind: "collection", source: Self.type),
                    DiscoveredRoot(slug: "beta", displayName: "Beta", kind: "collection", source: Self.type)
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
                url: "https://multiroot/\(key)")
        }
    }

    @Test func multiRootFlatSourcePersistsEachPageUnderItsOwnRoot() async throws {
        let context = SourceContext(
            client: StubClient { _ in
                HTTPClientResponse(status: .init(code: 200), headerFields: [:], body: ResponseBody(buffered: []))
            },
            rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlmulti-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = try Database.open(
            at: dir.appendingPathComponent("m.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let alphaId = try CrawlPersist.upsertRoot(
            db, slug: "alpha", displayName: "Alpha", kind: "collection", source: "multiroot", now: now)
        let betaId = try CrawlPersist.upsertRoot(
            db, slug: "beta", displayName: "Beta", kind: "collection", source: "multiroot", now: now)

        let driver = CrawlDriver(registry: SourceRegistry([MultiRootAdapter.self]))
        let stats = try await driver.crawl(
            sourceType: "multiroot", into: db, rootId: alphaId,
            rootIds: ["alpha": alphaId, "beta": betaId], context: context, now: now)

        #expect(stats.discovered == 3)
        #expect(stats.persisted == 3)
        #expect(stats.failed == 0)

        // Each page attributed to its own root: alpha/one + alpha/two under alpha, beta/one under beta.
        let rows = try db.prepare("SELECT root_id AS r, COUNT(*) AS c FROM pages GROUP BY root_id").all([:])
        var byRoot: [Int64: Int] = [:]
        for row in rows {
            guard case .integer(let r) = row["r"], case .integer(let c) = row["c"] else { continue }
            byRoot[r] = Int(c)
        }
        #expect(byRoot[alphaId] == 2)
        #expect(byRoot[betaId] == 1)
    }
}

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
}

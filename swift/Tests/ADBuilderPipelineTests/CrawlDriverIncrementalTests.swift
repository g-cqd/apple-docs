// Gate for the incremental re-crawl (Workstream 1b): the driver reads each key's stored validator and
// runs the adapter's conditional `check` BEFORE fetching, skipping unchanged pages. Two adapters pin the
// two outcomes: one whose `check` always reports `.unchanged` (first crawl persists since there is no
// prior validator yet; the re-crawl skips every key), and one that always reports `.modified` (the
// re-crawl re-fetches + persists). Both normalize with `url == nil` so the persisted path is the
// key-derived fallback `/<key>` — exactly what the driver looks the validator up by pre-fetch.
//
// Split into one @Test per crawl outcome (shared crawl-twice helper) to stay inside the package's
// 100 ms type-check budget — the two-phase bodies tripped the hard gate.

import ADBuilder
import ADDB
import ADSQLModel
import ADWrite
import Foundation
import HTTPTypes
import Testing

@testable import ADBuilderPipeline

struct CrawlDriverIncrementalTests {
    private struct StubClient: HTTPClient {
        func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
            HTTPClientResponse(status: .init(code: 200), headerFields: [:], body: ResponseBody(buffered: []))
        }
    }

    /// Three keys; `fetch` carries a per-key ETag (so the first crawl stores a validator); `normalize`
    /// sets `url` to the key-derived path `/<key>` (pages.url is NOT NULL) so the page persists under the
    /// SAME path the driver looks the validator up by pre-fetch (`CrawlDriver.crawlPath(forKey:)`). The
    /// `check` outcome is the only thing that differs between the two adapters below.
    private static func keys(_ type: String) -> [String] { ["\(type)/a", "\(type)/b", "\(type)/c"] }

    private static func page(_ type: String, _ key: String) -> NormalizedPage {
        NormalizedPage(
            document: ADBuilder.NormalizedDocument(
                sourceType: type, key: key, title: key, url: "/\(key)", abstractText: "body"))
    }

    /// An adapter whose conditional `check` always reports `.unchanged`.
    private struct UnchangedAdapter: SourceAdapter {
        static let type = "inc-unchanged"
        static let displayName = "Inc Unchanged"
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: CrawlDriverIncrementalTests.keys(Self.type))
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            FetchResult(key: key, payload: .html("<main><h1>\(key)</h1></main>"), etag: "etag-\(key)")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .unchanged, changed: false, newState: previousState) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            CrawlDriverIncrementalTests.page(Self.type, key)
        }
    }

    /// An adapter whose conditional `check` always reports `.modified`.
    private struct ModifiedAdapter: SourceAdapter {
        static let type = "inc-modified"
        static let displayName = "Inc Modified"
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: CrawlDriverIncrementalTests.keys(Self.type))
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            FetchResult(key: key, payload: .html("<main><h1>\(key)</h1></main>"), etag: "etag-\(key)")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .modified, changed: true, newState: "etag-\(key)-next") }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            CrawlDriverIncrementalTests.page(Self.type, key)
        }
    }

    private func freshDatabase(_ dir: URL, now: String) throws -> (db: Database, rootId: Int64) {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let db = try Database.open(
            at: dir.appendingPathComponent("inc.adsql").path, options: DatabaseOptions())
        try migrateSchema(db)
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "inc", displayName: "Inc", kind: "collection", source: "inc", now: now)
        return (db, rootId)
    }

    private func context() -> SourceContext {
        SourceContext(client: StubClient(), rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))
    }

    /// Runs a first crawl + an immediate re-crawl of `sourceType` against ONE fresh DB (so the
    /// re-crawl sees the validators the first crawl stored) and returns both outcome stats.
    private func crawlTwice(
        _ adapters: [any SourceAdapter.Type], sourceType: String
    ) async throws -> (first: CrawlDriver.Stats, second: CrawlDriver.Stats) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("crawlinc-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let now = "2026-06-20T00:00:00.000Z"
        let (db, rootId) = try freshDatabase(dir, now: now)
        defer { db.close() }
        let driver = CrawlDriver(registry: SourceRegistry(adapters))
        let first = try await driver.crawl(
            sourceType: sourceType, into: db, rootId: rootId, context: context(), now: now)
        let second = try await driver.crawl(
            sourceType: sourceType, into: db, rootId: rootId, context: context(), now: now)
        return (first: first, second: second)
    }

    // First crawl: no validators on disk yet, so `check` is never consulted — every page is fetched.
    @Test func firstCrawlPersistsAllBeforeValidatorsExist() async throws {
        let first = try await crawlTwice([UnchangedAdapter.self], sourceType: "inc-unchanged").first
        #expect(first.discovered == 3)
        #expect(first.persisted == 3)
        #expect(first.skipped == 0)
        #expect(first.failed == 0)
    }

    // Re-crawl: every page now has a stored ETag and `check` says unchanged → all skipped, none fetched.
    @Test func unchangedCheckSkipsTheRecrawl() async throws {
        let second = try await crawlTwice([UnchangedAdapter.self], sourceType: "inc-unchanged").second
        #expect(second.discovered == 3)
        #expect(second.skipped == second.discovered)
        #expect(second.persisted == 0)
        #expect(second.failed == 0)
    }

    @Test func modifiedAdapterFirstCrawlPersistsAll() async throws {
        let first = try await crawlTwice([ModifiedAdapter.self], sourceType: "inc-modified").first
        #expect(first.persisted == 3)
        #expect(first.skipped == 0)
    }

    // Re-crawl: validators exist, but `check` reports modified → re-fetched + persisted, none skipped.
    @Test func modifiedCheckRefetches() async throws {
        let second = try await crawlTwice([ModifiedAdapter.self], sourceType: "inc-modified").second
        #expect(second.discovered == 3)
        #expect(second.persisted == 3)
        #expect(second.skipped == 0)
        #expect(second.failed == 0)
    }
}

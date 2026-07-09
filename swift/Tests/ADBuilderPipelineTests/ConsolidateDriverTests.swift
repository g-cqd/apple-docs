// Gate for ConsolidateDriver — the failed-crawl doctor end-to-end over stub adapters
// (no network): resolved-path retries persist through the crawl pipeline (rows
// indistinguishable from crawl-persisted ones, same-root refs seeded), an
// already-persisted target short-circuits without fetching, a failing retry re-marks
// the old row, the transient sweep recovers ONLY transient-classified rows (with the
// JS backoff schedule, injectable sleep), checkpoint resume skips analysis and
// continues at nextIndex, and dry-run mutates nothing.

import ADBuilder
import ADStorage
import ADWrite
import Foundation
import Synchronization
import Testing

@testable import ADBuilderPipeline

struct ConsolidateDriverTests {
    private static let now = "2026-07-09T00:00:00.000Z"

    // MARK: - fixtures

    /// A migrated scratch corpus laid out like a data dir (`<dir>/apple-docs.db`).
    private struct Corpus {
        let dir: URL
        let db: SQLiteWriteConnection
        var dataDir: String { dir.path }

        static func make(_ label: String) throws -> Corpus {
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("consolidate-\(label)-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let db = try SQLiteWriteConnection(path: dir.appendingPathComponent("apple-docs.db").path)
            _ = try migrateSchema(db)
            return Corpus(dir: dir, db: db)
        }

        func destroy() {
            db.close()
            try? FileManager.default.removeItem(at: dir)
        }

        @discardableResult
        func addRoot(_ slug: String) throws -> Int64 {
            try CrawlPersist.upsertRoot(
                db, slug: slug, displayName: slug, kind: "framework", source: "apple-docc",
                sourceType: "apple-docc", now: now)
        }

        func seedFailed(_ path: String, rootSlug: String, error: String) throws {
            try CrawlPersist.seedCrawlIfNew(db, path: path, rootSlug: rootSlug, depth: 1)
            try CrawlPersist.setCrawlState(
                db, path: path, status: "failed", rootSlug: rootSlug, depth: 1, error: error)
        }

        func addDoc(rootId: Int64, key: String) throws {
            let doc = ADWrite.NormalizedDoc(
                document: ADWrite.NormalizedDocument(
                    sourceType: "apple-docc", key: key, title: "Title of \(key)",
                    url: "https://developer.apple.com/documentation/\(key)"),
                sections: [
                    ADWrite.NormalizedSection(
                        sectionKind: "discussion", heading: nil, contentText: "existing body",
                        contentJson: nil, sortOrder: 0)
                ],
                relationships: [])
            try CrawlPersist.persistNormalized(
                db, rootId: rootId, path: key, doc,
                hashes: .init(content: "c-\(key)", rawPayload: "r-\(key)"), now: now)
        }

        func writeFixture(at relative: String, _ text: String) throws {
            let url = dir.appendingPathComponent(relative)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try text.write(to: url, atomically: true, encoding: .utf8)
        }

        func status(of path: String) throws -> String? {
            try db.get(
                "SELECT status FROM crawl_state WHERE path = $path", ["path": .text(path)])?
                .text("status")
        }

        func count(_ sql: String) throws -> Int64 {
            try db.get(sql)?.int("c") ?? -1
        }
    }

    private static func context() -> SourceContext {
        struct NoClient: HTTPClient {
            func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
                throw HTTPClientError.connectionFailed("stub transport — adapters are mocked")
            }
        }
        return SourceContext(
            client: NoClient(), rateLimiter: RateLimiter(rate: 1_000_000, burst: 1_000_000))
    }

    private static func options(
        dryRun: Bool = false, minify: Bool = false, retryTransient: Bool = false,
        transientRounds: Int = 2, transientDelayMillis: Int = 30_000, concurrency: Int = 5,
        sleep: (@Sendable (Int) async throws -> Void)? = nil
    ) -> ConsolidateDriver.Options {
        ConsolidateDriver.Options(
            dryRun: dryRun, minify: minify, retryTransient: retryTransient,
            transientRounds: transientRounds, transientDelayMillis: transientDelayMillis,
            concurrency: concurrency, now: now, pid: 4242, log: nil, sleep: sleep ?? { _ in })
    }

    /// Serves any key as a small HTML page (with validators) and records fetched keys.
    private struct ServeMock: SourceAdapter {
        static let type = "apple-docc"
        static let displayName = "ServeMock"
        static let syncMode = SyncMode.crawl
        static let fetched = Mutex<[String]>([])
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: [])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            Self.fetched.withLock { $0.append(key) }
            return FetchResult(
                key: key, payload: .html("<main><h1>\(key)</h1><p>consolidated body</p></main>"),
                etag: "\"etag-\(key)\"", lastModified: "Mon, 01 Jan 2024 00:00:00 GMT")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .modified, changed: true) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            guard case .html(let html) = payload else { throw AdapterError.unexpectedPayload("html") }
            return HtmlNormalize.parse(
                html, key: key, sourceType: Self.type, kind: "article",
                framework: CrawlDriver.slug(ofKey: key),
                url: "https://developer.apple.com/documentation/\(key)")
        }
        func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
            [CrawlDriver.slug(ofKey: key) + "/seeded-ref", "otherroot/x"]
        }
    }

    /// Fetch always throws the native 503 spelling (still transient on re-mark).
    private struct ThrowingMock: SourceAdapter {
        static let type = "apple-docc"
        static let displayName = "ThrowingMock"
        static let syncMode = SyncMode.crawl
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: [])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            throw AdapterError.httpStatus(503, "https://mock/\(key)")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .error, changed: false) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            throw AdapterError.unexpectedPayload("never normalized")
        }
    }

    /// ThrowingMock with its own attempt counter (exclusively for the rounds gate).
    private struct Counting503Mock: SourceAdapter {
        static let type = "apple-docc"
        static let displayName = "Counting503Mock"
        static let syncMode = SyncMode.crawl
        static let attempts = Mutex<Int>(0)
        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(keys: [])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            Self.attempts.withLock { $0 += 1 }
            throw AdapterError.httpStatus(503, "https://mock/\(key)")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
            -> CheckResult
        { CheckResult(status: .error, changed: false) }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            throw AdapterError.unexpectedPayload("never normalized")
        }
    }

    // MARK: - step 3: resolved-path retries

    @Test func retriesResolvedPathsEndToEnd() async throws {
        let corpus = try Corpus.make("resolve")
        defer { corpus.destroy() }
        try corpus.addRoot("swiftui")
        try corpus.seedFailed("swiftui/old-a", rootSlug: "swiftui", error: "Not found")
        try corpus.seedFailed("swiftui/old-b", rootSlug: "swiftui", error: "Not found")
        try corpus.writeFixture(
            at: "raw-json/swiftui.json",
            """
            {"references":{
              "swiftui/old-a":{"url":"swiftui/new-a","title":"New A"},
              "swiftui/old-b":{"url":"swiftui/new-b","title":"New B"}
            }}
            """)

        let driver = ConsolidateDriver(registry: SourceRegistry([ServeMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(), options: Self.options())

        #expect(result.analyzed == 2)
        #expect(result.cleaned == 0)
        #expect(result.resolved == 2)
        #expect(result.retried == 2)
        #expect(result.retriedOk == 2)
        #expect(result.genuine == 0)
        #expect(result.dryRun == false)

        // Old rows deleted, new rows processed.
        #expect(try corpus.status(of: "swiftui/old-a") == nil)
        #expect(try corpus.status(of: "swiftui/old-b") == nil)
        #expect(try corpus.status(of: "swiftui/new-a") == "processed")
        #expect(try corpus.status(of: "swiftui/new-b") == "processed")

        // The re-fetched pages persisted through the crawl pipeline: documents +
        // sections + pages rows with the upstream validators, marked converted.
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM documents WHERE key = 'swiftui/new-a'") == 1)
        #expect(
            try corpus.count(
                "SELECT COUNT(*) AS c FROM document_sections WHERE document_id = "
                    + "(SELECT id FROM documents WHERE key = 'swiftui/new-a')") > 0)
        let page = try corpus.db.get(
            "SELECT etag, converted_at FROM pages WHERE path = 'swiftui/new-a'")
        #expect(page?.text("etag") == "\"etag-swiftui/new-a\"")
        #expect(page?.text("converted_at") == Self.now)

        // Same-root references seeded pending; the cross-root one ignored.
        #expect(try corpus.status(of: "swiftui/seeded-ref") == "pending")
        #expect(try corpus.status(of: "otherroot/x") == nil)

        // The retry checkpoint was cleared on completion.
        #expect(Consolidate.readCheckpoint(corpus.db) == nil)
    }

    @Test func existingPageShortCircuitsWithoutFetching() async throws {
        let corpus = try Corpus.make("existing")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot("shortui")
        try corpus.addDoc(rootId: rootId, key: "shortui/new-a")
        try corpus.seedFailed("shortui/old-a", rootSlug: "shortui", error: "Not found")
        try corpus.writeFixture(
            at: "raw-json/shortui.json",
            #"{"references":{"shortui/old-a":{"url":"shortui/new-a","title":"New A"}}}"#)

        // The adapter throws on fetch — a retriedOk outcome proves no fetch happened.
        let driver = ConsolidateDriver(registry: SourceRegistry([ThrowingMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(), options: Self.options())

        #expect(result.resolved == 1)
        #expect(result.retried == 1)
        #expect(result.retriedOk == 1)
        #expect(result.genuine == 0)
        #expect(try corpus.status(of: "shortui/old-a") == nil)
    }

    @Test func failedRetryRemarksTheOldPath() async throws {
        let corpus = try Corpus.make("refail")
        defer { corpus.destroy() }
        try corpus.addRoot("failui")
        try corpus.seedFailed("failui/old-a", rootSlug: "failui", error: "Not found")
        try corpus.writeFixture(
            at: "raw-json/failui.json",
            #"{"references":{"failui/old-a":{"url":"failui/new-a","title":"New A"}}}"#)

        let driver = ConsolidateDriver(registry: SourceRegistry([ThrowingMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(), options: Self.options())

        #expect(result.resolved == 1)
        #expect(result.retried == 1)
        #expect(result.retriedOk == 0)
        #expect(result.genuine == 1)
        // The OLD row is re-marked failed with the fresh native error string.
        let row = try corpus.db.get(
            "SELECT status, error FROM crawl_state WHERE path = 'failui/old-a'")
        #expect(row?.text("status") == "failed")
        #expect(row?.text("error")?.contains("httpStatus(503") == true)
        #expect(try corpus.status(of: "failui/new-a") == nil)
    }

    // MARK: - step 3b: transient sweep

    @Test func transientSweepRecoversOnlyTransientRows() async throws {
        let corpus = try Corpus.make("transient")
        defer { corpus.destroy() }
        try corpus.addRoot("transui")
        try corpus.seedFailed("transui/a", rootSlug: "transui", error: "HTTP 503 fetching https://x.json")
        try corpus.seedFailed("transui/b", rootSlug: "transui", error: "Not found")
        try corpus.seedFailed(
            "transui/c", rootSlug: "transui", error: #"httpStatus(503, "https://x.json")"#)

        let slept = Mutex<[Int]>([])
        let driver = ConsolidateDriver(registry: SourceRegistry([ServeMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(),
            options: Self.options(
                retryTransient: true, transientDelayMillis: 7,
                sleep: { milliseconds in slept.withLock { $0.append(milliseconds) } }))

        #expect(result.transientRecovered == 2)
        #expect(result.genuine == 1)  // the permanent 404 stays
        #expect(try corpus.status(of: "transui/a") == "processed")
        #expect(try corpus.status(of: "transui/b") == "failed")
        #expect(try corpus.status(of: "transui/c") == "processed")
        // One round with transients (30s-shaped backoff, scaled by the injectable);
        // the second probe finds none and exits without sleeping.
        #expect(slept.withLock { $0 } == [7])
        // Recovered pages persisted through the crawl pipeline…
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM documents WHERE key = 'transui/a'") == 1)
        // …but the transient sweep does NOT seed references (only step 3 does).
        #expect(try corpus.status(of: "transui/seeded-ref") == nil)
    }

    @Test func cleanCorpusPaysNoTransientDelay() async throws {
        let corpus = try Corpus.make("nodelay")
        defer { corpus.destroy() }
        try corpus.addRoot("calmui")
        try corpus.seedFailed("calmui/a", rootSlug: "calmui", error: "Not found")

        let slept = Mutex<[Int]>([])
        let driver = ConsolidateDriver(registry: SourceRegistry([ThrowingMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(),
            options: Self.options(
                retryTransient: true, transientRounds: 3, transientDelayMillis: 10_000,
                sleep: { milliseconds in slept.withLock { $0.append(milliseconds) } }))

        #expect(result.transientRecovered == 0)
        #expect(slept.withLock { $0 }.isEmpty)
        #expect(try corpus.status(of: "calmui/a") == "failed")
    }

    @Test func stillFailingTransientRetriesEachRoundAndStaysFailed() async throws {
        let corpus = try Corpus.make("rounds")
        defer { corpus.destroy() }
        try corpus.addRoot("roundui")
        try corpus.seedFailed(
            "roundui/a", rootSlug: "roundui", error: "HTTP 503 fetching https://x.json")

        let slept = Mutex<[Int]>([])
        let before = Counting503Mock.attempts.withLock { $0 }
        let driver = ConsolidateDriver(registry: SourceRegistry([Counting503Mock.self]))
        let outcome = try await driver.retryTransientFailures(
            corpus.db, context: Self.context(),
            options: Self.options(
                retryTransient: true, transientRounds: 2, transientDelayMillis: 3,
                sleep: { milliseconds in slept.withLock { $0.append(milliseconds) } }))

        // Retried both rounds (the re-marked native 503 still classifies transient),
        // with the JS `baseDelayMs * round` backoff schedule.
        #expect(Counting503Mock.attempts.withLock { $0 } - before == 2)
        #expect(slept.withLock { $0 } == [3, 6])
        #expect(outcome.recovered == 0)
        #expect(outcome.rounds == 2)
        #expect(outcome.remaining == 1)
        #expect(try corpus.status(of: "roundui/a") == "failed")
    }

    // MARK: - checkpoint resume

    @Test func checkpointResumeSkipsAnalysisAndContinuesAtNextIndex() async throws {
        let corpus = try Corpus.make("resume")
        defer { corpus.destroy() }
        try corpus.addRoot("resumeui")
        // A row the fresh analysis WOULD clean — its survival proves analysis was skipped.
        try corpus.seedFailed("resumeui/page#frag", rootSlug: "resumeui", error: "Not found")
        try Consolidate.writeCheckpoint(
            corpus.db,
            Consolidate.Checkpoint(
                analyzed: 5, cleaned: 2, resolved: 2, retried: 1, retriedOk: 1, nextIndex: 1,
                resolvedPaths: [
                    Consolidate.ResolvedPath(
                        oldPath: "resumeui/done-old", newPath: "resumeui/done-new",
                        root: "resumeui", title: nil),
                    Consolidate.ResolvedPath(
                        oldPath: "resumeui/pending-old", newPath: "resumeui/pending-new",
                        root: "resumeui", title: nil)
                ]),
            now: Self.now)
        try corpus.seedFailed("resumeui/pending-old", rootSlug: "resumeui", error: "Not found")

        let driver = ConsolidateDriver(registry: SourceRegistry([ServeMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(), options: Self.options())

        // Counters restored from the checkpoint (crossAdapter is never stored — JS quirk).
        #expect(result.analyzed == 5)
        #expect(result.cleaned == 2)
        #expect(result.crossAdapter == 0)
        #expect(result.resolved == 2)
        #expect(result.retried == 2)
        #expect(result.retriedOk == 2)

        // Only the pending entry was fetched; the completed one was not re-fetched.
        let fetchedPaths = ServeMock.fetched.withLock { $0 }
        #expect(fetchedPaths.contains("resumeui/pending-new"))
        #expect(!fetchedPaths.contains("resumeui/done-new"))

        // Analysis was skipped: the cleanable fragment row survives.
        #expect(try corpus.status(of: "resumeui/page#frag") == "failed")
        #expect(try corpus.status(of: "resumeui/pending-old") == nil)
        #expect(try corpus.status(of: "resumeui/pending-new") == "processed")
        #expect(Consolidate.readCheckpoint(corpus.db) == nil)
    }

    // MARK: - dry run

    @Test func dryRunReportsWithoutMutating() async throws {
        let corpus = try Corpus.make("dryrun")
        defer { corpus.destroy() }
        try corpus.addRoot("dryui")
        try corpus.seedFailed("dryui/page#frag", rootSlug: "dryui", error: "Not found")
        try corpus.seedFailed("dryui/old-a", rootSlug: "dryui", error: "Not found")
        try corpus.seedFailed(
            "dryui/slow", rootSlug: "dryui", error: "HTTP 503 fetching https://x.json")
        try corpus.writeFixture(
            at: "raw-json/dryui.json",
            #"{"references":{"dryui/old-a":{"url":"dryui/new-a","title":"New A"}}}"#)

        let slept = Mutex<[Int]>([])
        let driver = ConsolidateDriver(registry: SourceRegistry([ThrowingMock.self]))
        let result = try await driver.run(
            corpus.db, dataDir: corpus.dataDir, context: Self.context(),
            options: Self.options(
                dryRun: true, retryTransient: true,
                sleep: { milliseconds in slept.withLock { $0.append(milliseconds) } }))

        #expect(result.dryRun)
        #expect(result.analyzed == 3)
        #expect(result.cleaned == 1)
        #expect(result.resolved == 1)
        #expect(result.retried == 0)
        #expect(result.retriedOk == 0)
        #expect(result.transientRecovered == 0)
        #expect(result.genuine == 3)  // nothing deleted
        #expect(
            result.resolvedPaths == [
                Consolidate.ResolvedPath(
                    oldPath: "dryui/old-a", newPath: "dryui/new-a", root: "dryui", title: "New A")
            ])
        // No deletes, no retries, no transient sweep, no checkpoint.
        #expect(try corpus.status(of: "dryui/page#frag") == "failed")
        #expect(try corpus.status(of: "dryui/old-a") == "failed")
        #expect(try corpus.status(of: "dryui/slow") == "failed")
        #expect(slept.withLock { $0 }.isEmpty)
        #expect(Consolidate.readCheckpoint(corpus.db) == nil)
    }
}

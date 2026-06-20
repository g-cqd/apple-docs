// CrawlDriver — the source-agnostic crawl loop. Resolves an adapter from the registry, discovers its
// keys, then fetch → normalize → persist each through the established seams (HTTPClient transport,
// ADHTML parser, CrawlPipeline persist boundary). Per-key failures are counted, not fatal, so one bad
// page never aborts a crawl. This is the orchestrator the `ad-build sync` verb drives.
//
// v1 scope: sequential, always-fetch. Follow-ups (each independent): the incremental `check` →
// crawl_state skip, bounded concurrency, and the post-crawl `IndexEmbeddings.run` pass. The
// content/raw hashes are SHA-256 of the raw payload (the JS raw hash); the JS content_hash uses the
// stable-stringified normalized doc, so cross-writer content-hash parity is a noted follow-up.

public import ADBuilder
public import ADDB
public import ADWrite

import Crypto
import Foundation

public struct CrawlDriver: Sendable {
    /// Per-crawl outcome counts.
    public struct Stats: Sendable, Equatable {
        public var discovered = 0
        public var persisted = 0
        public var failed = 0
        public init() {}
    }

    /// A `sync` outcome: the crawl stats plus the embedding-index result.
    public struct SyncResult: Sendable, Equatable {
        public var crawl: Stats
        public var index: IndexEmbeddings.Result
        public init(crawl: Stats, index: IndexEmbeddings.Result) {
            self.crawl = crawl
            self.index = index
        }
    }

    private let registry: SourceRegistry
    public init(registry: SourceRegistry) { self.registry = registry }

    /// Crawl one source end-to-end into `db`. Discovers keys, then fetch + normalize each (up to
    /// `maxConcurrency` in flight — the network-bound steps run in parallel), persisting results
    /// serially as they arrive (ADDB is single-writer, and `db` never crosses to a child task).
    @discardableResult
    public func crawl(
        sourceType: String, into db: Database, rootId: Int64, context: SourceContext, now: String,
        maxConcurrency: Int = 8
    ) async throws -> Stats {
        let adapter = try registry.adapter(for: sourceType)
        let discovery = try await adapter.discover(context)

        var stats = Stats()
        stats.discovered = discovery.keys.count

        var keys = discovery.keys.makeIterator()
        try await withThrowingTaskGroup(of: Fetched?.self) { group in
            for _ in 0 ..< Swift.max(1, maxConcurrency) {
                guard let key = keys.next() else { break }
                group.addTask { await self.fetchNormalize(adapter, key, context) }
            }
            while let result = try await group.next() {
                if let fetched = result {
                    do {
                        try CrawlPipeline.persist(
                            fetched.page, into: db, rootId: rootId, path: fetched.path,
                            hashes: .init(content: fetched.hash, rawPayload: fetched.hash), now: now)
                        stats.persisted += 1
                    } catch {
                        stats.failed += 1
                    }
                } else {
                    stats.failed += 1
                }
                if let key = keys.next() {
                    group.addTask { await self.fetchNormalize(adapter, key, context) }
                }
            }
        }
        return stats
    }

    /// One fetched + normalized page (or nil on a per-key failure). Carried out of a child task.
    private struct Fetched: Sendable {
        let page: NormalizedPage
        let path: String
        let hash: String
    }

    private func fetchNormalize(
        _ adapter: any SourceAdapter, _ key: String, _ context: SourceContext
    ) async -> Fetched? {
        do {
            let result = try await adapter.fetch(key, context)
            let page = try adapter.normalize(result.key, result.payload)
            return Fetched(
                page: page, path: page.document.url ?? "/\(key)",
                hash: Self.sha256Hex(Self.rawBytes(result.payload)))
        } catch {
            return nil
        }
    }

    /// Build (or resume) the embedding index over everything persisted so far — what makes crawled
    /// pages searchable. A thin pass-through to `IndexEmbeddings.run`.
    @discardableResult
    public func index(
        _ db: Database, embedder: some ChunkEmbedder, full: Bool = false
    ) throws -> IndexEmbeddings.Result {
        try IndexEmbeddings.run(db, embedder: embedder, full: full)
    }

    /// Crawl a source then index it — the full `ad-build sync` for one source.
    public func sync(
        sourceType: String, into db: Database, rootId: Int64, context: SourceContext, now: String,
        embedder: some ChunkEmbedder
    ) async throws -> SyncResult {
        let crawlStats = try await crawl(
            sourceType: sourceType, into: db, rootId: rootId, context: context, now: now)
        let indexResult = try IndexEmbeddings.run(db, embedder: embedder)
        return SyncResult(crawl: crawlStats, index: indexResult)
    }

    private static func rawBytes(_ payload: SourcePayload) -> [UInt8] {
        switch payload {
            case .html(let text), .markdown(let text): return Array(text.utf8)
            case .json(let bytes), .bytes(let bytes): return bytes
        }
    }

    private static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
    }
}

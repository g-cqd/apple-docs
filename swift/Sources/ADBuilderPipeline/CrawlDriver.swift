// CrawlDriver — the source-agnostic crawl loop. Resolves an adapter from the registry, discovers its
// keys, then fetch → normalize → persist each through the established seams (HTTPClient transport,
// ADHTML parser, CrawlPipeline persist boundary). Per-key failures are counted, not fatal, so one bad
// page never aborts a crawl. This is the orchestrator the `ad-build sync` verb drives.
//
// v1 scope: sequential, always-fetch. Follow-ups (each independent): the incremental `check` →
// crawl_state skip, bounded concurrency, and the post-crawl `IndexEmbeddings.run` pass. The
// documents/pages `content_hash` is SHA-256 of the STABLE-STRINGIFIED normalized doc (matching the
// JS persist.js content_hash — `sha256(stableStringify(normalized))`); the `raw_payload_hash` stays
// SHA-256 of the raw payload bytes (JS hashes `stableStringify(json)`, a separate noted follow-up).

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
        /// Pages whose stored validator + the adapter's conditional `check` reported `unchanged`, so
        /// the fetch (and persist) was skipped — the incremental re-crawl's request-saving outcome.
        public var skipped = 0
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

    /// Crawl one source end-to-end into `db`. Discovers keys; for each key already on disk with a stored
    /// HTTP validator, asks the adapter's conditional `check` whether the upstream changed and SKIPS the
    /// fetch when it hasn't (the incremental re-crawl). Survivors are then fetched + normalized (up to
    /// `maxConcurrency` in flight — the network-bound steps run in parallel) and persisted serially as
    /// they arrive (ADDB is single-writer, and `db` never crosses to a child task).
    @discardableResult
    public func crawl(
        sourceType: String, into db: Database, rootId: Int64, context: SourceContext, now: String,
        maxConcurrency: Int = 8
    ) async throws -> Stats {
        let adapter = try registry.adapter(for: sourceType)
        let discovery = try await adapter.discover(context)

        var stats = Stats()
        stats.discovered = discovery.keys.count

        // ── Phase 1: incremental check (serial; `db` stays on the consuming side) ───────────────────
        // For each key that already has a persisted validator, run the adapter's conditional check. The
        // validator READ touches `db` here, on the serial side, so `db` never crosses into a child task —
        // preserving the single-writer invariant. A check failure is non-fatal: we fall through to fetch.
        var keysToFetch: [String] = []
        keysToFetch.reserveCapacity(discovery.keys.count)
        for key in discovery.keys {
            if let etag = pagePreviousEtag(db, key: key),
                let result = try? await adapter.check(key, previousState: etag, context),
                result.status == .unchanged
            {
                stats.skipped += 1
                continue
            }
            keysToFetch.append(key)
        }

        // ── Phase 2: fetch + normalize survivors concurrently, persist serially ─────────────────────
        var keys = keysToFetch.makeIterator()
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
                            hashes: .init(content: fetched.contentHash, rawPayload: fetched.rawHash),
                            etag: fetched.etag, lastModified: fetched.lastModified, now: now)
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

    /// The ETag stored for `key`'s page, or `nil` when the page is new, has no stored ETag, or the read
    /// fails. Read on the SERIAL side so `db` never crosses into a child task. A non-nil result is the
    /// trigger for the conditional `check`; `nil` means "no prior state" → always fetch (a fresh crawl).
    private func pagePreviousEtag(_ db: Database, key: String) -> String? {
        let validator = try? CrawlPersist.pageValidator(db, path: Self.crawlPath(forKey: key))
        return validator?.etag
    }

    /// The storage path a key is persisted under when the normalized doc carries no URL — the same
    /// `fetchNormalize` fallback. Used to look the validator up BEFORE the fetch, by the key alone.
    static func crawlPath(forKey key: String) -> String { "/\(key)" }

    /// One fetched + normalized page (or nil on a per-key failure). Carried out of a child task. The
    /// `etag`/`lastModified` are the upstream HTTP validators (`FetchResult`), persisted for the next
    /// re-crawl's conditional check.
    private struct Fetched: Sendable {
        let page: NormalizedPage
        let path: String
        /// `content_hash` = SHA-256 of the stable-stringified normalized doc (JS persist parity).
        let contentHash: String
        /// `raw_payload_hash` = SHA-256 of the raw upstream payload bytes.
        let rawHash: String
        let etag: String?
        let lastModified: String?
    }

    private func fetchNormalize(
        _ adapter: any SourceAdapter, _ key: String, _ context: SourceContext
    ) async -> Fetched? {
        do {
            let result = try await adapter.fetch(key, context)
            let page = try adapter.normalize(result.key, result.payload)
            return Fetched(
                page: page, path: page.document.url ?? Self.crawlPath(forKey: key),
                contentHash: Self.sha256Hex(Array(page.stableStringified().utf8)),
                rawHash: Self.sha256Hex(Self.rawBytes(result.payload)),
                etag: result.etag, lastModified: result.lastModified)
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

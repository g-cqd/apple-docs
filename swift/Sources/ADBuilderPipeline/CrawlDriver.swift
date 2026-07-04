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
    ///
    /// A multi-root flat source (e.g. swift-docc's three archives) passes `rootIds` — a `slug -> rootId`
    /// map — so each page persists under its own root: the key's leading path segment is its root slug
    /// (`<slug>/…`, the JS `key.split('/', 1)[0]`). Keys whose slug matches no entry fall back to
    /// `rootId`; a single-root source leaves `rootIds` empty and everything lands under `rootId`.
    @discardableResult
    public func crawl(
        sourceType: String, into db: Database, rootId: Int64, rootIds: [String: Int64] = [:],
        context: SourceContext, now: String, maxConcurrency: Int = 8
    ) async throws -> Stats {
        let adapter = try registry.adapter(for: sourceType)
        let discovery = try await adapter.discover(context)

        // A reference-following source (`.crawl`, e.g. hig / apple-docc) drives a BFS over the
        // `crawl_state` frontier instead of the flat key list.
        if type(of: adapter).syncMode == .crawl {
            return try await crawlBFS(
                adapter, discovery: discovery, rootId: rootId, rootIds: rootIds,
                run: BFSRun(db: db, context: context, now: now, maxConcurrency: maxConcurrency))
        }

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
                let keyRootId = Self.rootId(forKey: key, rootIds: rootIds, default: rootId)
                group.addTask { await self.fetchNormalize(adapter, key, keyRootId, context) }
            }
            while let result = try await group.next() {
                if let fetched = result {
                    do {
                        try CrawlPipeline.persist(
                            fetched.page, into: db, rootId: fetched.rootId, path: fetched.path,
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
                    let keyRootId = Self.rootId(forKey: key, rootIds: rootIds, default: rootId)
                    group.addTask { await self.fetchNormalize(adapter, key, keyRootId, context) }
                }
            }
        }
        return stats
    }

    /// The rootId a key persists under: `rootIds[<leading path segment>]`, else the default `rootId`.
    /// The leading segment is the key's root slug (`<slug>/…`, the JS `key.split('/', 1)[0]`).
    static func rootId(forKey key: String, rootIds: [String: Int64], default defaultRootId: Int64) -> Int64 {
        guard !rootIds.isEmpty else { return defaultRootId }
        return rootIds[Self.slug(ofKey: key)] ?? defaultRootId
    }

    /// A key's root slug — its leading path segment (`<slug>/…`, the JS `key.split('/', 1)[0]`).
    static func slug(ofKey key: String) -> String { String(key.prefix { $0 != "/" }) }

    /// The reference-following (`.crawl`) path: seed the `crawl_state` frontier from the discovered keys,
    /// then BFS each root to exhaustion. Fetch+normalize run `maxConcurrency`-wide per batch; every `db`
    /// write (persist / seed / state) stays on the single-writer consuming side. Mirrors the JS
    /// `discover.js` crawlRoot loop over the shared `crawl_state` queue (its `pool(batch, concurrency)`).
    private func crawlBFS(
        _ adapter: any SourceAdapter, discovery: DiscoveryResult, rootId: Int64,
        rootIds: [String: Int64], run: BFSRun
    ) async throws -> Stats {
        // Seed: each discovered key is a root-owned entry point at depth 0 (idempotent — a re-seed of an
        // already-tracked path never resets its processed/failed status).
        for key in discovery.keys {
            try CrawlPersist.seedCrawlIfNew(run.db, path: key, rootSlug: Self.slug(ofKey: key), depth: 0)
        }
        var stats = Stats()
        for root in discovery.roots {
            try await crawlRoot(
                adapter, rootSlug: root.slug, rootId: rootIds[root.slug] ?? rootId, run: run, stats: &stats)
        }
        stats.discovered = stats.persisted + stats.failed
        return stats
    }

    /// BFS one root's `crawl_state` frontier: repeatedly pull the `pending` batch, fetch+normalize its
    /// paths `maxConcurrency`-wide (network-bound, in child tasks), then — serially on the single-writer
    /// side — persist each page, enqueue its same-root references one level deeper, and mark it
    /// `processed`. A fetch/normalize failure (404/403 or otherwise) demotes the path to `failed` and is
    /// non-fatal. Terminates when no `pending` paths remain (references are seeded idempotently, so a
    /// cyclic reference graph converges). The batch width tracks `maxConcurrency` so every slot stays busy.
    private func crawlRoot(
        _ adapter: any SourceAdapter, rootSlug: String, rootId: Int64, run: BFSRun, stats: inout Stats
    ) async throws {
        let db = run.db
        let context = run.context
        let width = Swift.max(1, run.maxConcurrency)
        while true {
            let pending = try CrawlPersist.getPendingCrawl(db, rootSlug: rootSlug, limit: width)
            if pending.isEmpty { break }
            try await withThrowingTaskGroup(of: BFSOutcome.self) { group in
                for (path, depth) in pending {
                    group.addTask { await self.bfsFetch(adapter, path: path, depth: depth, context) }
                }
                // Consume on the serial side — every `db` write happens here, so the single-writer `db`
                // never crosses into a child task (the flat path's discipline).
                for try await outcome in group {
                    switch outcome {
                        case .fetched(let f):
                            do {
                                try CrawlPipeline.persist(
                                    f.page, into: db, rootId: rootId, path: f.storePath,
                                    hashes: .init(content: f.contentHash, rawPayload: f.rawHash),
                                    etag: f.etag, lastModified: f.lastModified, now: run.now)
                                stats.persisted += 1
                                // Same-root references only — a cross-root ref belongs to that root's own crawl.
                                for ref in f.refs where Self.slug(ofKey: ref) == rootSlug {
                                    try CrawlPersist.seedCrawlIfNew(
                                        db, path: ref, rootSlug: rootSlug, depth: f.depth + 1)
                                }
                                try CrawlPersist.setCrawlState(
                                    db, path: f.statePath, status: "processed", rootSlug: rootSlug, depth: f.depth)
                            } catch {
                                try CrawlPersist.setCrawlState(
                                    db, path: f.statePath, status: "failed", rootSlug: rootSlug, depth: f.depth,
                                    error: String(describing: error))
                                stats.failed += 1
                            }
                        case .failed(let path, let depth, let error):
                            try CrawlPersist.setCrawlState(
                                db, path: path, status: "failed", rootSlug: rootSlug, depth: depth, error: error)
                            stats.failed += 1
                    }
                }
            }
        }
    }

    /// The invariants threaded unchanged through a BFS crawl — the target `db`, the HTTP `context`, the
    /// `now` timestamp, and the per-batch fan-out width. Bundled into one value so the BFS helpers thread
    /// the crawl's fixed context without an overlong parameter list.
    private struct BFSRun {
        let db: Database
        let context: SourceContext
        let now: String
        let maxConcurrency: Int
    }

    /// A BFS batch item's outcome, carried out of its child task. `.fetched` still needs the serial
    /// persist; `.failed` only needs its `crawl_state` demotion (both carry the original state path/depth).
    private enum BFSOutcome: Sendable {
        case fetched(BFSFetched)
        case failed(path: String, depth: Int, error: String)
    }

    /// One BFS page fetched + normalized in a child task. `statePath` is the `crawl_state` key the state
    /// row is keyed by; `storePath` is where the page persists (its doc URL, or the `/<key>` fallback).
    /// `refs` is pre-extracted in the child (a pure step) so the consuming side only writes.
    private struct BFSFetched: Sendable {
        let statePath: String
        let storePath: String
        let depth: Int
        let page: NormalizedPage
        let refs: [String]
        let contentHash: String
        let rawHash: String
        let etag: String?
        let lastModified: String?
    }

    /// Fetch + normalize + extract-references one BFS path (all pure/network — no `db`), for concurrent
    /// execution in a task group. Any failure becomes `.failed` (non-fatal; the path is demoted).
    private func bfsFetch(
        _ adapter: any SourceAdapter, path: String, depth: Int, _ context: SourceContext
    ) async -> BFSOutcome {
        do {
            let result = try await adapter.fetch(path, context)
            let page = try adapter.normalize(result.key, result.payload)
            let refs = adapter.extractReferences(result.key, result.payload)
            return .fetched(
                BFSFetched(
                    statePath: path, storePath: page.document.url ?? Self.crawlPath(forKey: path),
                    depth: depth, page: page, refs: refs,
                    contentHash: Self.sha256Hex(Array(page.stableStringified().utf8)),
                    rawHash: Self.sha256Hex(Self.rawBytes(result.payload)),
                    etag: result.etag, lastModified: result.lastModified))
        } catch {
            return .failed(path: path, depth: depth, error: String(describing: error))
        }
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
        /// The root this key resolved to (`crawl`'s `rootIds[slug] ?? rootId`), carried out of the child
        /// task so the serial persist attributes each page to its own root.
        let rootId: Int64
        /// `content_hash` = SHA-256 of the stable-stringified normalized doc (JS persist parity).
        let contentHash: String
        /// `raw_payload_hash` = SHA-256 of the raw upstream payload bytes.
        let rawHash: String
        let etag: String?
        let lastModified: String?
    }

    private func fetchNormalize(
        _ adapter: any SourceAdapter, _ key: String, _ rootId: Int64, _ context: SourceContext
    ) async -> Fetched? {
        do {
            let result = try await adapter.fetch(key, context)
            let page = try adapter.normalize(result.key, result.payload)
            return Fetched(
                page: page, path: page.document.url ?? Self.crawlPath(forKey: key), rootId: rootId,
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
        sourceType: String, into db: Database, rootId: Int64, rootIds: [String: Int64] = [:],
        context: SourceContext, now: String, embedder: some ChunkEmbedder
    ) async throws -> SyncResult {
        let crawlStats = try await crawl(
            sourceType: sourceType, into: db, rootId: rootId, rootIds: rootIds, context: context, now: now)
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

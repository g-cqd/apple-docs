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
//
// Path convention (RFC 0007 §11 findings #8/#9, resolved at storage-pivot stage 2c): a page persists
// under its BARE crawl key — `pages.path` == `crawl_state.path` == `documents.key` (the JS persist.js
// convention; `pipeline/persist.js` passes the crawl path straight through to `upsertPage`, and the
// full external URL goes in the separate `pages.url` column). The ADDB-era driver instead stored
// `page.document.url` in `pages.path`, which broke every JS-shaped `pages.path = documents.key` join
// on natively-crawled corpora; converging on the JS key made those joins (browse/framework-tree/
// web-build/link-audit/orphan-check) correct for BOTH engines' corpora again.

public import ADBuilder
public import ADStorage
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

    /// A `sync` outcome: the crawl stats, the body-index result (the JS sync's
    /// post-crawl documents_body_fts phase), and the embedding-index result.
    public struct SyncResult: Sendable, Equatable {
        public var crawl: Stats
        public var body: IndexBody.Result
        public var index: IndexEmbeddings.Result
        public init(crawl: Stats, body: IndexBody.Result, index: IndexEmbeddings.Result) {
            self.crawl = crawl
            self.body = body
            self.index = index
        }
    }

    private let registry: SourceRegistry
    public init(registry: SourceRegistry) { self.registry = registry }

    /// Emit a progress callback every this many processed (persisted + failed) pages,
    /// so a long reference-following source (apple-docc: ~350K pages over hours) is
    /// observable instead of a silent black box until completion.
    static let progressInterval = 100

    /// Crawl one source end-to-end into `db`. Discovers keys; for each key already on disk with a stored
    /// HTTP validator, asks the adapter's conditional `check` whether the upstream changed and SKIPS the
    /// fetch when it hasn't (the incremental re-crawl). Survivors are then fetched + normalized (up to
    /// `maxConcurrency` in flight — the network-bound steps run in parallel) and persisted serially as
    /// they arrive (the write connection is single-writer, and `db` never crosses to a child task).
    ///
    /// A multi-root flat source (e.g. swift-docc's three archives) passes `rootIds` — a `slug -> rootId`
    /// map — so each page persists under its own root: the key's leading path segment is its root slug
    /// (`<slug>/…`, the JS `key.split('/', 1)[0]`). Keys whose slug matches no entry fall back to
    /// `rootId`; a single-root source leaves `rootIds` empty and everything lands under `rootId`.
    @discardableResult
    public func crawl(
        sourceType: String, into db: SQLiteWriteConnection, rootId: Int64, rootIds: [String: Int64] = [:],
        context: SourceContext, now: String, maxConcurrency: Int = 8, dataDir: String? = nil,
        onProgress: (@Sendable (Stats) -> Void)? = nil
    ) async throws -> Stats {
        let adapter = try registry.adapter(for: sourceType)
        let discovery = try await adapter.discover(context)

        // A reference-following source (`.crawl`, e.g. hig / apple-docc) drives a BFS over the
        // `crawl_state` frontier instead of the flat key list.
        if type(of: adapter).syncMode == .crawl {
            let stats = try await crawlBFS(
                adapter, discovery: discovery, rootId: rootId, rootIds: rootIds,
                run: BFSRun(db: db, context: context, now: now, maxConcurrency: maxConcurrency, dataDir: dataDir),
                onProgress: onProgress)
            try Self.refreshRootPageCounts(db, rootId: rootId, rootIds: rootIds)
            return stats
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
                group.addTask { await self.fetchNormalize(adapter, key, keyRootId, context, dataDir: dataDir) }
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
                if let onProgress, (stats.persisted + stats.failed) % Self.progressInterval == 0 {
                    onProgress(stats)
                }
                if let key = keys.next() {
                    let keyRootId = Self.rootId(forKey: key, rootIds: rootIds, default: rootId)
                    group.addTask { await self.fetchNormalize(adapter, key, keyRootId, context, dataDir: dataDir) }
                }
            }
        }
        try Self.refreshRootPageCounts(db, rootId: rootId, rootIds: rootIds)
        return stats
    }

    /// Recompute `roots.page_count` for every root this call touched (the JS `db.updateRootPageCount`,
    /// called once per root after its own crawl loop exhausts) — every root in `rootIds` plus the default
    /// `rootId` (a single-root source's only root, or a multi-root source's fallback).
    private static func refreshRootPageCounts(_ db: SQLiteWriteConnection, rootId: Int64, rootIds: [String: Int64])
        throws
    {
        var ids = Set(rootIds.values)
        ids.insert(rootId)
        for id in ids {
            try CrawlPersist.refreshRootPageCount(db, rootId: id)
        }
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
    /// then drain the WHOLE frontier — every root THIS CALL OWNS pooled into one loop — to exhaustion.
    /// Fetch+normalize run `maxConcurrency`-wide per batch; every `db` write (persist / seed / state) stays
    /// on the single-writer consuming side. Mirrors the JS `discover.js` crawl over the shared `crawl_state`
    /// queue (its one `pool(batch, concurrency)` across all roots).
    private func crawlBFS(
        _ adapter: any SourceAdapter, discovery: DiscoveryResult, rootId: Int64,
        rootIds: [String: Int64], run: BFSRun, onProgress: (@Sendable (Stats) -> Void)? = nil
    ) async throws -> Stats {
        // Index `crawl_state.status` once so pulling the pending frontier stays an index seek as the
        // processed pile grows (else `getPendingCrawlAny` degrades to an O(N) scan per pull).
        try CrawlPersist.ensureCrawlStatusIndex(run.db)
        // Seed: each discovered key is a root-owned entry point at depth 0 (idempotent — a re-seed of an
        // already-tracked path never resets its processed/failed status).
        for key in discovery.keys {
            try CrawlPersist.seedCrawlIfNew(run.db, path: key, rootSlug: Self.slug(ofKey: key), depth: 0)
        }
        // The CLOSED set of `root_slug` values this call's frontier can ever contain: `rootIds`' own
        // registered slugs (the normal case — every real caller populates this via `upsertCrawlRoots`)
        // UNIONED with every depth-0 seed's own derived slug (covers a source whose discovered keys use a
        // slug not present in its own `discovery.roots` — an adapter-level edge case — and the `rootIds:
        // [:]` single-root convenience some callers/tests use). This is safe to compute ONCE, before the
        // frontier loop starts, because a deeper seed always INHERITS its parent's `rootSlug` verbatim
        // rather than re-deriving one (`crawlFrontier`'s `f.refs.filter { Self.slug(ofKey: $0) ==
        // f.rootSlug }` copies `f.rootSlug`, never a freshly-computed slug) — so no root_slug outside this
        // set can ever be seeded later. Over-including a slug this call doesn't end up using is harmless
        // (nothing pending exists under it yet); the only thing that must never happen is UNDER-including
        // one of this call's own roots, which would silently starve part of its own frontier.
        let ownedRootSlugs = Set(rootIds.keys).union(discovery.keys.map { Self.slug(ofKey: $0) })
        var stats = Stats()
        try await crawlFrontier(
            adapter, rootId: rootId, rootIds: rootIds, ownedRootSlugs: ownedRootSlugs, run: run,
            stats: &stats, onProgress: onProgress)
        stats.discovered = stats.persisted + stats.failed
        return stats
    }

    /// Drain the whole `crawl_state` frontier belonging to `ownedRootSlugs` — every root THIS CALL OWNS,
    /// pooled into one loop — as a STREAMING sliding window: keep `maxConcurrency` fetches in flight AT ALL
    /// TIMES, refilling each slot the instant a fetch completes rather than waiting for a whole
    /// barrier-synchronized wave. That is what keeps the fan-out saturated: a single slow or hung fetch (up
    /// to the 30 s request deadline) ties up only its own slot, where a barrier would leave the other
    /// `maxConcurrency - 1` workers idle until the straggler timed out. Each completed page is persisted
    /// under its OWN root (`rootIds[row.rootSlug] ?? rootId`), its same-root references seeded one level
    /// deeper, and its path marked `processed` (batched); a fetch/normalize/persist failure demotes the path
    /// to `failed` and is non-fatal. Every `db` write happens on THIS serial task — child tasks only
    /// fetch/normalize, so the single-writer `db` never crosses a task boundary (the flat path's
    /// discipline). Terminates when no `pending` path remains WITHIN `ownedRootSlugs` (references are
    /// seeded idempotently, so a cyclic graph converges) — a `pending` backlog under any OTHER root_slug
    /// (a different source's own frontier, mid-crawl or abandoned) is invisible to this loop and is never
    /// touched, drained, or mis-attributed to this call's root(s).
    private func crawlFrontier(
        _ adapter: any SourceAdapter, rootId: Int64, rootIds: [String: Int64], ownedRootSlugs: Set<String>,
        run: BFSRun, stats: inout Stats, onProgress: (@Sendable (Stats) -> Void)? = nil
    ) async throws {
        let db = run.db
        let context = run.context
        let width = Swift.max(1, run.maxConcurrency)

        // A path is dispatched at most once: `inFlight` holds paths being fetched, `succeeded` holds
        // completed-OK paths not yet bulk-marked `processed`. Both are still `pending` in the DB, so the
        // frontier pull below skips in-flight rows and flushes the marks before re-pulling — a completed row
        // never re-enters the window.
        var inFlight: Set<String> = []
        var succeeded: [String] = []
        var buffer: [(path: String, rootSlug: String, depth: Int)] = []
        var offset = 0

        // The next un-dispatched frontier path, or nil when the frontier is (currently) drained. Refills the
        // buffer from the DB — flushing this window's `processed` marks first so completed rows drop out of
        // the pull — and skips anything already in flight. One re-pull per drain: if it surfaces no new path
        // it returns nil, and the in-flight fetches seed the next level (each completion re-drives `fill`).
        func nextPath() throws -> (path: String, rootSlug: String, depth: Int)? {
            while offset < buffer.count {
                let row = buffer[offset]
                offset += 1
                if !inFlight.contains(row.path) { return row }
            }
            if !succeeded.isEmpty {
                try CrawlPersist.markCrawlProcessed(db, paths: succeeded)
                succeeded.removeAll(keepingCapacity: true)
            }
            buffer = try CrawlPersist.getPendingCrawlAny(db, rootSlugs: ownedRootSlugs, limit: width * 8)
            offset = 0
            while offset < buffer.count {
                let row = buffer[offset]
                offset += 1
                if !inFlight.contains(row.path) { return row }
            }
            return nil
        }

        try await withThrowingTaskGroup(of: BFSOutcome.self) { group in
            // Top the window back up to `width` in-flight fetches.
            func fill() throws {
                while inFlight.count < width, let row = try nextPath() {
                    inFlight.insert(row.path)
                    let (path, rootSlug, depth) = (row.path, row.rootSlug, row.depth)
                    group.addTask {
                        await self.bfsFetch(
                            adapter, path: path, rootSlug: rootSlug, depth: depth, context, dataDir: run.dataDir)
                    }
                }
            }
            try fill()
            while let outcome = try await group.next() {
                switch outcome {
                    case .fetched(let f):
                        inFlight.remove(f.path)
                        do {
                            try CrawlPipeline.persist(
                                f.page, into: db, rootId: rootIds[f.rootSlug] ?? rootId, path: f.path,
                                hashes: .init(content: f.contentHash, rawPayload: f.rawHash),
                                etag: f.etag, lastModified: f.lastModified, now: run.now)
                            stats.persisted += 1
                            // Same-root references only — a cross-root ref belongs to that root's own crawl.
                            // ONE transaction for all of a page's seeds (vs one per ref): the per-ref
                            // transaction was the crawl's dominant serial-write cost (the ~70 pages/s ceiling).
                            let seeds = f.refs
                                .filter { Self.slug(ofKey: $0) == f.rootSlug }
                                .map { (path: $0, rootSlug: f.rootSlug, depth: f.depth + 1) }
                            try CrawlPersist.seedCrawlBatch(db, seeds)
                            succeeded.append(f.path)
                            // Flush in `width`-sized bunches so a kill re-processes at most one window, while
                            // still amortizing the mark over many rows (the seek fast path makes it cheap).
                            if succeeded.count >= width {
                                try CrawlPersist.markCrawlProcessed(db, paths: succeeded)
                                succeeded.removeAll(keepingCapacity: true)
                            }
                        } catch {
                            try CrawlPersist.setCrawlState(
                                db, path: f.path, status: "failed", rootSlug: f.rootSlug, depth: f.depth,
                                error: String(describing: error))
                            stats.failed += 1
                        }
                    case .failed(let path, let rootSlug, let depth, let error):
                        inFlight.remove(path)
                        try CrawlPersist.setCrawlState(
                            db, path: path, status: "failed", rootSlug: rootSlug, depth: depth, error: error)
                        stats.failed += 1
                }
                if let onProgress, (stats.persisted + stats.failed) % Self.progressInterval == 0 {
                    onProgress(stats)
                }
                try fill()
            }
        }
        // Mark any successes from the final partial window.
        if !succeeded.isEmpty {
            try CrawlPersist.markCrawlProcessed(db, paths: succeeded)
        }
    }

    /// The invariants threaded unchanged through a BFS crawl — the target `db`, the HTTP `context`, the
    /// `now` timestamp, and the per-batch fan-out width. Bundled into one value so the BFS helpers thread
    /// the crawl's fixed context without an overlong parameter list.
    private struct BFSRun {
        let db: SQLiteWriteConnection
        let context: SourceContext
        let now: String
        let maxConcurrency: Int
        /// When set, every fetched JSON payload is stableStringified + written to
        /// `<dataDir>/raw-json/<key>.json` (persist.js's raw store — what
        /// `Snapshot.embedRawPayloads` packs into `document_raw`).
        let dataDir: String?
    }

    /// A BFS batch item's outcome, carried out of its child task. `.fetched` still needs the serial
    /// persist; `.failed` only needs its `crawl_state` demotion. Both carry the original state path, its
    /// root slug (the frontier pools every root THIS CALL OWNS, so each item names its own), and depth.
    private enum BFSOutcome: Sendable {
        case fetched(BFSFetched)
        case failed(path: String, rootSlug: String, depth: Int, error: String)
    }

    /// One BFS page fetched + normalized in a child task. `path` is the bare crawl key — BOTH the
    /// `crawl_state` key the state row is keyed by AND the path the page persists under (`pages.path` /
    /// `documents.key`, the JS persist.js convention; the full URL lands in the separate `pages.url`
    /// column). `rootSlug` is the page's owning root (the cross-root frontier pools every root this call
    /// owns into one wave). `refs` is pre-extracted in the child (a pure step) so the consuming side
    /// only writes.
    private struct BFSFetched: Sendable {
        let path: String
        let rootSlug: String
        let depth: Int
        let page: NormalizedPage
        let refs: [String]
        let contentHash: String
        let rawHash: String
        let etag: String?
        let lastModified: String?
    }

    /// Fetch + normalize + extract-references one BFS path (all pure/network — no `db`), for concurrent
    /// execution in a task group. `rootSlug` (the page's owning root) is threaded through so the serial
    /// consumer can attribute + re-seed without re-deriving it. Any failure becomes `.failed` (non-fatal).
    private func bfsFetch(
        _ adapter: any SourceAdapter, path: String, rootSlug: String, depth: Int, _ context: SourceContext,
        dataDir: String?
    ) async -> BFSOutcome {
        do {
            let result = try await adapter.fetch(path, context)
            let page = try adapter.normalize(result.key, result.payload)
            let refs = adapter.extractReferences(result.key, result.payload)
            let raw = try Self.persistRaw(result.payload, key: path, dataDir: dataDir)
            return .fetched(
                BFSFetched(
                    path: path,
                    rootSlug: rootSlug, depth: depth, page: page, refs: refs,
                    contentHash: Self.sha256Hex(Array(page.stableStringified().utf8)),
                    rawHash: raw,
                    etag: result.etag, lastModified: result.lastModified))
        } catch {
            return .failed(path: path, rootSlug: rootSlug, depth: depth, error: String(describing: error))
        }
    }

    /// The ETag stored for `key`'s page, or `nil` when the page is new, has no stored ETag, or the read
    /// fails. Read on the SERIAL side so `db` never crosses into a child task. A non-nil result is the
    /// trigger for the conditional `check`; `nil` means "no prior state" → always fetch (a fresh crawl).
    /// Keyed by the bare crawl key — the SAME `pages.path` the persist writes (the JS persist.js
    /// convention), so the incremental check always finds the row the previous crawl stored.
    private func pagePreviousEtag(_ db: SQLiteWriteConnection, key: String) -> String? {
        let validator = try? CrawlPersist.pageValidator(db, path: key)
        return validator?.etag
    }

    /// One fetched + normalized page (or nil on a per-key failure). Carried out of a child task. The
    /// `etag`/`lastModified` are the upstream HTTP validators (`FetchResult`), persisted for the next
    /// re-crawl's conditional check.
    private struct Fetched: Sendable {
        let page: NormalizedPage
        /// The bare crawl key the page persists under (`pages.path`/`documents.key` — JS persist.js).
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
        _ adapter: any SourceAdapter, _ key: String, _ rootId: Int64, _ context: SourceContext,
        dataDir: String?
    ) async -> Fetched? {
        do {
            let result = try await adapter.fetch(key, context)
            let page = try adapter.normalize(result.key, result.payload)
            let raw = try Self.persistRaw(result.payload, key: key, dataDir: dataDir)
            return Fetched(
                page: page, path: key, rootId: rootId,
                contentHash: Self.sha256Hex(Array(page.stableStringified().utf8)),
                rawHash: raw,
                etag: result.etag, lastModified: result.lastModified)
        } catch {
            return nil
        }
    }

    /// Build (or resume) the embedding index over everything persisted so far — what makes crawled
    /// pages searchable. A thin pass-through to `IndexEmbeddings.run`.
    @discardableResult
    public func index(
        _ db: SQLiteWriteConnection, embedder: some ChunkEmbedder, full: Bool = false
    ) throws -> IndexEmbeddings.Result {
        try IndexEmbeddings.run(db, embedder: embedder, full: full)
    }

    /// Crawl a source, body-index it, then embed-index it — the full `ad-cli sync`
    /// for one source. The body pass sits in the JS sync's position (post-crawl,
    /// before anything reads documents_body_fts); incremental by default — only
    /// documents updated since the last `body_indexed_at` stamp are re-rendered.
    public func sync(
        sourceType: String, into db: SQLiteWriteConnection, rootId: Int64, rootIds: [String: Int64] = [:],
        context: SourceContext, now: String, embedder: (some ChunkEmbedder)?, dataDir: String? = nil
    ) async throws -> SyncResult {
        let crawlStats = try await crawl(
            sourceType: sourceType, into: db, rootId: rootId, rootIds: rootIds, context: context, now: now,
            dataDir: dataDir)
        let bodyResult = try IndexBody.runIncremental(db, now: now)
        // nil embedder (no model resources on this host) ⇒ the embedding pass is SKIPPED,
        // not failed — the JS sync's behavior with a dormant semantic tier: crawl + body
        // index land, the run succeeds, and Result.skipped records the non-run.
        let indexResult = try embedder.map { try IndexEmbeddings.run(db, embedder: $0) } ?? .skipped
        return SyncResult(crawl: crawlStats, body: bodyResult, index: indexResult)
    }

    static func rawBytes(_ payload: SourcePayload) -> [UInt8] {
        switch payload {
            case .html(let text), .markdown(let text): return Array(text.utf8)
            case .json(let bytes), .bytes(let bytes): return bytes
        }
    }

    static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
    }
}

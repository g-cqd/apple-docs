public import AppleDocsCore
public import AppleDocsSources
public import AppleDocsStorage

/// Resumable, durable multi-phase sync orchestrator over `crawl_state`, `sync_checkpoint`,
/// ``SourceAdapter``, ``UpstreamHTTPClient``, and ``CorpusStore``.
///
/// Keeps up to `concurrency` (default `16`) fetches in flight with a refilling worker pool (no batch barriers:
/// a slow page never stalls dispatch of the next ones), while every completed page is committed by the parent
/// task in its own SQLite transaction, so the database is never touched concurrently.
public enum SyncOrchestrator: Sendable {
    /// Execution bounds and policy for one resumable sync run.
    public struct Options: Hashable, Sendable {
        public let maxPages: Int
        public let maxDepth: Int
        public let tombstoneThreshold: Int
        public let concurrency: Int
        public let stayWithinSeedRoot: Bool

        public init(
            maxPages: Int = 100,
            maxDepth: Int = 3,
            tombstoneThreshold: Int = 2,
            concurrency: Int = 16,
            stayWithinSeedRoot: Bool = true
        ) {
            self.maxPages = max(1, maxPages)
            self.maxDepth = max(0, maxDepth)
            self.tombstoneThreshold = max(1, tombstoneThreshold)
            self.concurrency = max(1, min(concurrency, 256))
            self.stayWithinSeedRoot = stayWithinSeedRoot
        }
    }

    /// Summary statistics returned by ``sync(adapter:seeds:client:into:options:)``.
    public struct RunReport: Hashable, Sendable {
        public let source: SourceKind
        public let fetchedModified: Int
        public let skippedNotModified: Int
        public let tombstoned: Int
        public let errors: Int
        public let discoveredQueued: Int

        public static let empty = RunReport(source: .appleDocC, counters: Counters())

        init(source: SourceKind, counters: Counters) {
            self.source = source
            self.fetchedModified = counters.modified
            self.skippedNotModified = counters.skipped
            self.tombstoned = counters.tombstoned
            self.errors = counters.errors
            self.discoveredQueued = counters.discovered
        }
    }

    /// What one worker-pool run crawls: the roots it may claim pending rows from, with each root's adapter.
    struct RunContext {
        let adapters: [String: any SourceAdapter]
        let client: UpstreamHTTPClient
        let store: CorpusStore
        let options: Options

        /// The claimable roots as a JSON array (bound to `json_each`).
        var rootsJSON: String {
            "["
                + adapters.keys.sorted().map { "\"" + $0.replacingScalars(["\\": "\\\\", "\"": "\\\""]) + "\"" }
                .joined(separator: ",") + "]"
        }
    }

    struct Counters {
        var modified = 0
        var skipped = 0
        var tombstoned = 0
        var errors = 0
        var discovered = 0

        mutating func add(_ other: Counters) {
            modified += other.modified
            skipped += other.skipped
            tombstoned += other.tombstoned
            errors += other.errors
            discovered += other.discovered
        }
    }

    struct PendingFetch: Sendable {
        let path: String
        let depth: Int
        let rootSlug: String
        let key: DocumentKey?
        let etag: String?
    }

    struct FetchedEntry: Sendable {
        let path: String
        let depth: Int
        let rootSlug: String
        let key: DocumentKey?
        let outcome: Result<SourceFetchOutcome, any Error>
    }

    public static func sync(
        adapter: any SourceAdapter,
        seeds: [DocumentKey]? = nil,
        client: UpstreamHTTPClient,
        into store: CorpusStore,
        options: Options = Options()
    ) async throws -> RunReport {
        let initialSeeds = seeds ?? adapter.seedKeys
        let rootSlug = initialSeeds.first?.rootSlug ?? adapter.defaultRoot.slug
        let root = CorpusRootRecord(
            slug: rootSlug,
            displayName: rootSlug == adapter.defaultRoot.slug ? adapter.defaultRoot.displayName : rootSlug,
            kind: adapter.defaultRoot.kind,
            sourceType: adapter.kind,
            seedPath: initialSeeds.first?.rawValue ?? adapter.defaultRoot.seedPath
        )
        try seedQueue(root: root, seeds: initialSeeds, into: store)
        let context = RunContext(adapters: [rootSlug: adapter], client: client, store: store, options: options)
        let counters = try await runWorkerPool(context: context)
        try refreshRootStats(rootSlug: rootSlug, seedPath: root.seedPath, on: store.connection)

        try writeCheckpoint(
            key: "sync:\(adapter.kind.rawValue):last_phase",
            value: SyncPhase.consolidate.rawValue,
            on: store.connection
        )
        return RunReport(source: adapter.kind, counters: counters)
    }

    static func fetchOne(
        _ item: PendingFetch,
        adapter: any SourceAdapter,
        client: UpstreamHTTPClient
    ) async -> FetchedEntry {
        func entry(_ outcome: Result<SourceFetchOutcome, any Error>) -> FetchedEntry {
            FetchedEntry(path: item.path, depth: item.depth, rootSlug: item.rootSlug, key: item.key, outcome: outcome)
        }
        guard let key = item.key else {
            return entry(.failure(SourceError.unsafeURL(item.path, reason: "invalid key")))
        }
        do {
            let outcome = try await adapter.fetch(key: key, previousETag: item.etag, client: client)
            return entry(.success(preconverted(outcome)))
        } catch {
            return entry(.failure(error))
        }
    }

    /// Converts a modified payload here, in the parallel fetch task, so the single committing task only
    /// writes: conversion is pure CPU and was ~60 % of the serial commit path. A payload that fails to
    /// convert is passed through unchanged, so the commit reports the same error as before.
    private static func preconverted(_ outcome: SourceFetchOutcome) -> SourceFetchOutcome {
        guard case .modified(let payload, let etag, let discoveredKeys) = outcome, payload.converted == nil,
            let converted = try? SyncPipeline.convert(payload)
        else {
            return outcome
        }
        return .modified(payload: SourcePayload(converted: converted), etag: etag, discoveredKeys: discoveredKeys)
    }
}

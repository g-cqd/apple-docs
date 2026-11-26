public import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsSources
public import AppleDocsStorage
public import Foundation

/// Corpus-scale sync — Bun's `sync` / `update` flow for DocC sources over the whole catalog:
///
/// 1. refresh the root catalog from Apple's technologies index;
/// 2. per Apple DocC root, fetch its navigation index conditionally: an unchanged index (304, or the same bytes under
///    a rotated ETag) skips every page of the root; a changed one seeds pages new to the index and revalidates the
///    root's pages (conditional GETs). Every 7 days, or with `full`, every page is revalidated;
/// 3. crawl all selected roots in one breadth-first worker pool under one concurrency limit;
/// 4. commit each root's index ETag only once its queue drained, so an interrupted run never trusts it.
public enum CorpusSync {
    public struct Options: Sendable {
        /// Sources whose roots are synced (catalog roots are Apple DocC; `design` is the HIG).
        public var sources: Set<SourceKind>
        /// Restricts the run to these root slugs.
        public var roots: Set<String>?
        public var discoverRoots: Bool
        /// Revalidate every page (and retry failed ones), regardless of index gates.
        public var full: Bool
        public var concurrency: Int
        public var maxPages: Int
        public var maxDepth: Int
        public var tombstoneThreshold: Int
        public var fullSweepInterval: TimeInterval
        public var now: Date
        /// The semantic index stage after the crawl (`nil` skips it; search then stays lexical for new pages).
        public var embeddings: EmbeddingStage?

        public init(
            sources: Set<SourceKind> = [.appleDocC, .hig],
            roots: Set<String>? = nil,
            discoverRoots: Bool = true,
            full: Bool = false,
            concurrency: Int = 32,
            maxPages: Int = Int.max,
            maxDepth: Int = 1_000,
            tombstoneThreshold: Int = 2,
            fullSweepInterval: TimeInterval = 7 * 24 * 60 * 60,
            now: Date = Date(),
            embeddings: EmbeddingStage? = nil
        ) {
            self.sources = sources
            self.roots = roots
            self.discoverRoots = discoverRoots
            self.full = full
            self.concurrency = max(1, min(concurrency, 256))
            self.maxPages = max(1, maxPages)
            self.maxDepth = max(0, maxDepth)
            self.tombstoneThreshold = max(1, tombstoneThreshold)
            self.fullSweepInterval = fullSweepInterval
            self.now = now
            self.embeddings = embeddings
        }
    }

    /// The model the post-crawl embedding stage uses.
    public struct EmbeddingStage: Sendable {
        public let embedder: Model2VecEmbedder
        public let modelName: String

        public init(embedder: Model2VecEmbedder, modelName: String) {
            self.embedder = embedder
            self.modelName = modelName
        }
    }

    public struct Report: Sendable {
        public var rootsDiscovered = 0
        public var rootsSelected = 0
        /// Roots skipped because their index did not change.
        public var rootsUnchanged = 0
        public var pagesSeededFromIndex = 0
        /// Roots whose index could not be fetched, with the error (their pages were revalidated instead).
        public var indexFailures: [String: String] = [:]
        public var fullSweep = false
        public var crawl = SyncOrchestrator.RunReport.empty
        /// Documents and chunks embedded after the crawl (`nil` when the stage did not run).
        public var embeddings: ChunkEmbeddingIndexer.Report?
    }

    public static func run(
        client: UpstreamHTTPClient,
        store: CorpusStore,
        options: Options = Options()
    ) async throws -> Report {
        var report = Report()
        if options.discoverRoots, !options.sources.isDisjoint(with: [.appleDocC, .hig]) {
            report.rootsDiscovered = try await refreshCatalog(client: client, store: store)
        }
        let roots = try selectRoots(store: store, options: options)
        report.rootsSelected = roots.count
        report.fullSweep = try startSweepIfDue(store: store, options: options)

        let gate = try await RootIndexGate.evaluate(
            roots: roots.filter { $0.sourceType == .appleDocC },
            client: client,
            store: store,
            concurrency: options.concurrency
        )
        report.rootsUnchanged = gate.unchanged.count
        report.pagesSeededFromIndex = gate.seededPages
        report.indexFailures = gate.failures
        let revalidate =
            report.fullSweep ? roots.map(\.slug) : roots.map(\.slug).filter { !gate.unchanged.contains($0) }
        try prepareQueue(roots: roots, revalidate: revalidate, retryFailed: options.full, store: store)

        var adapters: [String: any SourceAdapter] = [:]
        for root in roots { adapters[root.slug] = SourceRegistry.adapter(for: root.sourceType) }
        let context = SyncOrchestrator.RunContext(
            adapters: adapters,
            client: client,
            store: store,
            options: SyncOrchestrator.Options(
                maxPages: options.maxPages,
                maxDepth: options.maxDepth,
                tombstoneThreshold: options.tombstoneThreshold,
                concurrency: options.concurrency
            )
        )
        let counters = try await SyncOrchestrator.runWorkerPool(context: context)
        report.crawl = SyncOrchestrator.RunReport(source: .appleDocC, counters: counters)
        for root in roots {
            try SyncOrchestrator.refreshRootStats(rootSlug: root.slug, seedPath: root.seedPath, on: store.connection)
        }
        try gate.commit(drainedOnly: true, store: store)
        if let stage = options.embeddings {
            report.embeddings = try await ChunkEmbeddingIndexer.run(
                store: store,
                embedder: stage.embedder,
                modelName: stage.modelName,
                full: options.full
            )
        }
        return report
    }
}

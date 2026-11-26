public import AppleDocsCore
public import AppleDocsSearch
public import AppleDocsSources
public import AppleDocsStorage
public import Foundation

/// Corpus-scale multi-source sync — Bun's `sync` / `update` flow across all 12 documentation sources:
///
/// 1. refresh the root catalog from Apple's technologies index and run parallel `discover()` across every
///    selected non-DocC adapter (`swift-docc`, `external-docc`, `swift-evolution`, `swift-book`, `guidelines`,
///    `wwdc`, `sample-code`, `swift-org`, `apple-archive`, `packages`), supplementing `sample-code` from any
///    `role='sampleCode'` pages already in the corpus;
/// 2. per Apple DocC root, fetch its navigation index conditionally: an unchanged index (304, or the same bytes under
///    a rotated ETag) skips every page of the root; a changed one seeds pages new to the index and revalidates the
///    root's pages (conditional GETs). Every 7 days, or with `full`, every page is revalidated;
/// 3. crawl all selected roots in one breadth-first worker pool under one concurrency limit;
/// 4. commit each root's index ETag only once its queue drained, merge local Xcode MobileAsset documentation when
///    present, and update chunk embeddings.
public enum CorpusSync {
    public struct Options: Sendable {
        /// Sources whose roots are synced (defaults to all 12 registered `SourceKind`s).
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
        /// Merge local Xcode MobileAsset documentation (`index.sql`) after a full-catalog DocC crawl
        /// (`nil` auto-enables when `roots == nil`, disabled on scoped `--root` runs unless explicitly set).
        public var enrichMobileAsset: Bool?
        /// Explicit Xcode MobileAsset `index.sql` path (`nil` auto-discovers under `/System/Library/AssetsV2`).
        public var mobileAssetDBPath: String?
        /// The semantic index stage after the crawl (`nil` skips it; search then stays lexical for new pages).
        public var embeddings: EmbeddingStage?

        public init(
            sources: Set<SourceKind> = Set(SourceKind.allCases),
            roots: Set<String>? = nil,
            discoverRoots: Bool = true,
            full: Bool = false,
            concurrency: Int = 32,
            maxPages: Int = Int.max,
            maxDepth: Int = 1_000,
            tombstoneThreshold: Int = 2,
            fullSweepInterval: TimeInterval = 7 * 24 * 60 * 60,
            now: Date = Date(),
            enrichMobileAsset: Bool? = false,
            mobileAssetDBPath: String? = nil,
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
            self.enrichMobileAsset = enrichMobileAsset
            self.mobileAssetDBPath = mobileAssetDBPath
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
        /// Non-DocC sources whose discovery failed (`source.rawValue` → error).
        public var discoveryFailures: [String: String] = [:]
        public var fullSweep = false
        public var crawl = SyncOrchestrator.RunReport.empty
        /// Xcode MobileAsset enrichment stats (`nil` when no asset was found or enrichment was disabled).
        public var enrichment: MobileAssetEnricher.Report?
        /// Documents and chunks embedded after the crawl (`nil` when the stage did not run).
        public var embeddings: ChunkEmbeddingIndexer.Report?
    }

    public static func run(
        client: UpstreamHTTPClient,
        store: CorpusStore,
        options: Options = Options()
    ) async throws -> Report {
        var report = Report()
        let adaptersByKind = Dictionary(
            uniqueKeysWithValues: options.sources.map { ($0, SourceRegistry.adapter(for: $0)) }
        )
        if options.discoverRoots {
            try await runDiscoveryPhase(
                adaptersByKind: adaptersByKind,
                client: client,
                store: store,
                options: options,
                report: &report
            )
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
        report.pagesSeededFromIndex += gate.seededPages
        report.indexFailures = gate.failures
        let revalidate =
            report.fullSweep ? roots.map(\.slug) : roots.map(\.slug).filter { !gate.unchanged.contains($0) }
        try prepareQueue(roots: roots, revalidate: revalidate, retryFailed: options.full, store: store)

        report.crawl = try await runCrawlPool(
            roots: roots,
            adaptersByKind: adaptersByKind,
            client: client,
            store: store,
            options: options
        )
        try gate.commit(drainedOnly: true, store: store)
        try await runPostCrawlPhases(store: store, options: options, report: &report)
        return report
    }

    private static func runDiscoveryPhase(
        adaptersByKind: [SourceKind: any SourceAdapter],
        client: UpstreamHTTPClient,
        store: CorpusStore,
        options: Options,
        report: inout Report
    ) async throws {
        if !options.sources.isDisjoint(with: [.appleDocC, .hig]) {
            report.rootsDiscovered += try await refreshCatalog(client: client, store: store)
        }
        let discovered = try await discoverNonDocCSources(
            adaptersByKind: adaptersByKind,
            client: client,
            store: store,
            options: options
        )
        report.rootsDiscovered += discovered.rootsAdded
        report.pagesSeededFromIndex += discovered.keysSeeded
        report.discoveryFailures = discovered.failures
    }

    private static func runCrawlPool(
        roots: [CorpusRootRecord],
        adaptersByKind: [SourceKind: any SourceAdapter],
        client: UpstreamHTTPClient,
        store: CorpusStore,
        options: Options
    ) async throws -> SyncOrchestrator.RunReport {
        var adaptersByRoot: [String: any SourceAdapter] = [:]
        for root in roots {
            adaptersByRoot[root.slug] = adaptersByKind[root.sourceType] ?? SourceRegistry.adapter(for: root.sourceType)
        }
        let context = SyncOrchestrator.RunContext(
            adapters: adaptersByRoot,
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
        for root in roots {
            try SyncOrchestrator.refreshRootStats(rootSlug: root.slug, seedPath: root.seedPath, on: store.connection)
        }
        return SyncOrchestrator.RunReport(source: .appleDocC, counters: counters)
    }

    private static func runPostCrawlPhases(
        store: CorpusStore,
        options: Options,
        report: inout Report
    ) async throws {
        let shouldEnrich = options.enrichMobileAsset ?? (options.roots == nil)
        if shouldEnrich, options.sources.contains(.appleDocC) {
            report.enrichment = try MobileAssetEnricher.runIfNeeded(
                store: store,
                assetDBPath: options.mobileAssetDBPath,
                full: options.full
            )
        }
        if let stage = options.embeddings {
            report.embeddings = try await ChunkEmbeddingIndexer.run(
                store: store,
                embedder: stage.embedder,
                modelName: stage.modelName,
                full: options.full
            )
        }
    }
}

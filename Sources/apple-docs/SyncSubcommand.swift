import AppleDocsCommands
import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSearch
import AppleDocsSources
import AppleDocsStorage
import ArgumentParser

struct SyncSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync",
        abstract: "Synchronize documentation from Apple and Swift sources into a Swift v1 corpus.",
        discussion: """
            Without --seed, syncs the entire corpus across all 12 sources: refreshes Apple's technologies catalog \
            and non-DocC source inventories, skips DocC roots whose navigation index is unchanged, crawls every \
            selected root in one pool, merges local Xcode MobileAsset documentation when present, and updates \
            semantic chunk embeddings. With --seed, crawls one source from the given pages.
            """
    )

    @Option(name: .shortAndLong, help: "Source slug (repeatable). Default: all 12 sources.")
    var source: [String] = []

    @Option(name: .long, help: "Only sync these root slugs (repeatable).")
    var root: [String] = []

    @Option(name: .long, help: "Crawl one source from these document keys instead of the whole catalog (repeatable).")
    var seed: [String] = []

    @Flag(name: .long, help: "Revalidate every page and retry failed ones, ignoring index gates.")
    var full = false

    @Flag(name: .long, inversion: .prefixedNo, help: "Discover roots and flat-source inventories before crawling.")
    var discover = true

    @Flag(name: .long, inversion: .prefixedNo, help: "Merge local Xcode MobileAsset documentation when present.")
    var enrich = true

    @Flag(name: .long, inversion: .prefixedNo, help: "Update the semantic search index after the crawl.")
    var embeddings = true

    @Option(name: .long, help: "Maximum pages to fetch (default: unlimited; 50 with --seed).")
    var maxPages: Int?

    @Option(name: .long, help: "Maximum crawl link depth (default: 1000; 2 with --seed).")
    var maxDepth: Int?

    @Option(name: .long, help: "Concurrent in-flight HTTP requests (1-256).")
    var concurrency = 100

    @Option(name: .long, help: "Maximum requests per second on primary Apple hosts (0 for unlimited).")
    var rate = 500.0

    @Option(name: .long, help: "Target Swift v1 corpus database path.")
    var db: String?

    @Flag(name: .long, help: "List all 12 supported upstream source adapters and exit.")
    var listSources = false

    func run() async throws {
        if listSources {
            for adapter in SourceRegistry.allAdapters {
                print("\(adapter.kind.rawValue)\t\(adapter.displayName)")
            }
            return
        }
        let kinds = try source.map { name in
            guard let kind = SourceKind(rawValue: name.lowercased()) else {
                throw ValidationError("Unknown source '\(name)'. Pass --list-sources to see all 12 sources.")
            }
            return kind
        }
        let store = try CorpusStore(path: db ?? CorpusPaths.defaultDatabasePath(), options: .readWrite)
        defer { store.close() }
        if seed.isEmpty {
            try await syncCorpus(kinds: kinds, store: store)
        } else {
            try await syncSeeds(kind: kinds.first ?? .appleDocC, store: store)
        }
    }

    private func syncCorpus(kinds: [SourceKind], store: CorpusStore) async throws {
        let selectedSources: Set<SourceKind>
        if !kinds.isEmpty {
            selectedSources = Set(kinds)
        } else if !root.isEmpty {
            // When `--root` is given without `--source`, keep all sources so any matching root slug is found,
            // while `discoverNonDocCSources` filters to the requested root slugs.
            selectedSources = Set(SourceKind.allCases)
        } else {
            selectedSources = Set(SourceKind.allCases)
        }
        let report = try await CorpusSync.run(
            client: client(),
            store: store,
            options: CorpusSync.Options(
                sources: selectedSources,
                roots: root.isEmpty ? nil : Set(root.map { $0.lowercased() }),
                discoverRoots: discover,
                full: full,
                concurrency: concurrency,
                maxPages: maxPages ?? Int.max,
                maxDepth: maxDepth ?? 1_000,
                enrichMobileAsset: enrich && root.isEmpty,
                embeddings: embeddingStage()
            )
        )
        for (sourceName, error) in report.discoveryFailures.sorted(by: { $0.key < $1.key }) {
            print("warning: discovery failed for \(sourceName) (\(error))")
        }
        for (slug, error) in report.indexFailures.sorted(by: { $0.key < $1.key }).prefix(10) {
            print("warning: index for \(slug) unavailable (\(error)); revalidated its pages instead")
        }
        if let enriched = report.enrichment, !enriched.skippedUnchanged {
            print(
                "Xcode asset merge: \(enriched.usrBackfilled) USRs, \(enriched.platformsBackfilled) platform backfills, \(enriched.novelInserted) novel pages"
            )
        }
        if let embedded = report.embeddings {
            print("Semantic index: \(embedded.chunks) chunks embedded across \(embedded.documents) documents")
        }
        let crawl = report.crawl
        print(
            """
            Synced \(report.rootsSelected) roots (\(report.rootsUnchanged) unchanged by index, \
            \(report.pagesSeededFromIndex) pages seeded from indexes\(report.fullSweep ? ", full revalidation" : "")): \
            modified=\(crawl.fetchedModified), 304=\(crawl.skippedNotModified), tombstoned=\(crawl.tombstoned), \
            discovered=\(crawl.discoveredQueued), errors=\(crawl.errors)
            """
        )
    }

    /// The upstream client, paced per hostname (`rate` on Apple origins, polite 20 req/s buckets on GitHub /
    /// swift.org / third-party hosts), with one HTTP connection per in-flight request.
    private func client() -> UpstreamHTTPClient {
        let limiter: HostRateLimiter? =
            rate > 0
            ? HostRateLimiter(primaryRate: rate, primaryBurst: max(1, Int(rate)))
            : nil
        return UpstreamHTTPClient(
            transport: NativeUpstreamTransport(maxConnectionsPerHost: concurrency),
            policy: UpstreamHTTPClient.Policy(hostRateLimiter: limiter)
        )
    }

    /// The semantic model when installed (`apple-docs setup`), else `nil` with a note: search stays lexical.
    private func embeddingStage() -> CorpusSync.EmbeddingStage? {
        guard embeddings else { return nil }
        let directory = CorpusPaths.defaultModelDirectory()
        guard let embedder = try? Model2VecEmbedder(modelDirectory: directory) else {
            print("note: semantic index skipped (no model at \(directory)); run `apple-docs setup` to install it")
            return nil
        }
        return CorpusSync.EmbeddingStage(embedder: embedder, modelName: CorpusPaths.defaultEmbeddingModelName)
    }

    private func syncSeeds(kind: SourceKind, store: CorpusStore) async throws {
        let report = try await SyncOrchestrator.sync(
            adapter: SourceRegistry.adapter(for: kind),
            seeds: try seed.map { try DocumentKey($0) },
            client: client(),
            into: store,
            options: SyncOrchestrator.Options(
                maxPages: maxPages ?? 50,
                maxDepth: maxDepth ?? 2,
                concurrency: concurrency
            )
        )
        print(
            "Synced \(report.source.rawValue): modified=\(report.fetchedModified), 304=\(report.skippedNotModified), tombstoned=\(report.tombstoned), discovered=\(report.discoveredQueued), errors=\(report.errors)"
        )
    }
}

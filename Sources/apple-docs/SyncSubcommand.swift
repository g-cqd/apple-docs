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
            Without --seed, syncs the whole catalog: refreshes the roots from Apple's technologies index, skips \
            roots whose navigation index is unchanged, revalidates the others with conditional requests, and crawls \
            every selected root in one pool. With --seed, crawls one source from the given pages.
            """
    )

    @Option(name: .shortAndLong, help: "Source slug (repeatable). Default: apple-docc and hig.")
    var source: [String] = []

    @Option(name: .long, help: "Only sync these root slugs (repeatable).")
    var root: [String] = []

    @Option(name: .long, help: "Crawl one source from these document keys instead of the whole catalog (repeatable).")
    var seed: [String] = []

    @Flag(name: .long, help: "Revalidate every page and retry failed ones, ignoring index gates.")
    var full = false

    @Flag(name: .long, inversion: .prefixedNo, help: "Refresh the root catalog from Apple's technologies index.")
    var discover = true

    @Flag(name: .long, inversion: .prefixedNo, help: "Update the semantic search index after the crawl.")
    var embeddings = true

    @Option(name: .long, help: "Maximum pages to fetch (default: unlimited; 50 with --seed).")
    var maxPages: Int?

    @Option(name: .long, help: "Maximum crawl link depth (default: 1000; 2 with --seed).")
    var maxDepth: Int?

    @Option(name: .long, help: "Concurrent in-flight HTTP requests (1-256).")
    var concurrency = 32

    @Option(name: .long, help: "Target Swift v1 corpus database path.")
    var db: String?

    @Flag(name: .long, help: "List all 11 supported upstream source adapters and exit.")
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
                throw ValidationError("Unknown source '\(name)'. Pass --list-sources to see all 11 sources.")
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
        let report = try await CorpusSync.run(
            client: UpstreamHTTPClient(),
            store: store,
            options: CorpusSync.Options(
                sources: kinds.isEmpty ? [.appleDocC, .hig] : Set(kinds),
                roots: root.isEmpty ? nil : Set(root.map { $0.lowercased() }),
                discoverRoots: discover,
                full: full,
                concurrency: concurrency,
                maxPages: maxPages ?? Int.max,
                maxDepth: maxDepth ?? 1_000,
                embeddings: embeddingStage()
            )
        )
        for (slug, error) in report.indexFailures.sorted(by: { $0.key < $1.key }).prefix(10) {
            print("warning: index for \(slug) unavailable (\(error)); revalidated its pages instead")
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
            client: UpstreamHTTPClient(),
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

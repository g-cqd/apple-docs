import AppleDocsCommands
import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSources
import AppleDocsStorage
import ArgumentParser

/// `apple-docs sync` subcommand running resumable upstream crawls across any of the 11 registered sources.
struct SyncSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync",
        abstract: "Synchronize documentation from upstream Apple and Swift sources into a Swift v1 corpus."
    )

    @Option(name: .shortAndLong, help: "Source slug (apple-docc, hig, guidelines, wwdc, swift-evolution, ...).")
    var source = "apple-docc"

    @Option(name: .long, help: "Optional seed document keys to enqueue (may be repeated).")
    var seed: [String] = []

    @Option(name: .long, help: "Maximum pages to fetch in this run.")
    var maxPages = 50

    @Option(name: .long, help: "Maximum crawl link depth.")
    var maxDepth = 2

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
        guard let kind = SourceKind(rawValue: source.lowercased()) else {
            throw ValidationError("Unknown source '\(source)'. Pass --list-sources to see all 11 sources.")
        }
        let adapter = SourceRegistry.adapter(for: kind)
        let parsedSeeds: [DocumentKey]? = seed.isEmpty ? nil : try seed.map { try DocumentKey($0) }
        let store = try CorpusStore(path: db ?? CorpusPaths.defaultDatabasePath(), options: .readWrite)
        defer { store.close() }

        let report = try await SyncOrchestrator.sync(
            adapter: adapter,
            seeds: parsedSeeds,
            client: UpstreamHTTPClient(),
            into: store,
            options: SyncOrchestrator.Options(maxPages: maxPages, maxDepth: maxDepth)
        )
        print(
            "Synced \(report.source.rawValue): modified=\(report.fetchedModified), 304=\(report.skippedNotModified), tombstoned=\(report.tombstoned), discovered=\(report.discoveredQueued), errors=\(report.errors)"
        )
    }
}

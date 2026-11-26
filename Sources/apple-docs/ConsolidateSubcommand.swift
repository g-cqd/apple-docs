import AppleDocsCommands
import AppleDocsPipeline
import AppleDocsSources
import AppleDocsStorage
import ArgumentParser

struct ConsolidateSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "consolidate",
        abstract: "Repair failed crawl entries, drop false positives, sweep orphan edges, and retry failures."
    )

    @Flag(name: .long, help: "Inspect without modifying the database or issuing retry requests.")
    var dryRun = false

    @Option(name: .long, help: "Concurrent in-flight HTTP retry requests (1-256).")
    var concurrency = 32

    @Option(name: .long, help: "Target Swift v1 corpus database path.")
    var db: String?

    func run() async throws {
        let store = try CorpusStore(path: db ?? CorpusPaths.defaultDatabasePath(), options: .readWrite)
        defer { store.close() }
        let client = UpstreamHTTPClient(
            transport: URLSessionUpstreamTransport(maxConnectionsPerHost: concurrency),
            policy: UpstreamHTTPClient.Policy(hostRateLimiter: HostRateLimiter())
        )
        let report = try await CorpusConsolidator.run(
            client: client,
            store: store,
            concurrency: concurrency,
            dryRun: dryRun
        )
        print(
            """
            Consolidate\(dryRun ? " (dry-run)" : ""): analyzed=\(report.analyzed), \
            cleaned_invalid=\(report.cleanedInvalid), cleaned_cross_adapter=\(report.cleanedCrossAdapter), \
            orphan_edges_removed=\(report.orphanRelationshipsRemoved), \
            retried_recovered=\(report.retriedRecovered), still_failing=\(report.retriedStillFailing)
            """
        )
    }
}

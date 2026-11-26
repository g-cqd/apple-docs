import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// Shared CLI flags (`--db`, `--json`) and read-only store helper for query subcommands.
struct QueryCLIOptions: ParsableArguments {
    @Option(name: .long, help: "Override corpus database path.")
    var db: String?

    @Flag(name: .long, help: "Emit machine-readable JSON.")
    var json = false

    func runQuery<Result: Encodable>(
        _ fetch: (CorpusStore) throws -> Result,
        formatText: (Result) -> String
    ) throws {
        let store = try CorpusStore(path: db ?? CorpusPaths.defaultDatabasePath(), options: .readOnly)
        defer { store.close() }
        let value = try fetch(store)
        print(json ? try PublicProjection.encodeJSON(value, pretty: true) : formatText(value))
    }
}

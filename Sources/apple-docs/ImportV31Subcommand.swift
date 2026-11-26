// @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape across subcommands
import AppleDocsCommands
import AppleDocsStorage
import ArgumentParser

/// `apple-docs import-v31` subcommand migrating a legacy Bun v31 database into Swift v1.
// @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape across subcommands
struct ImportV31Subcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "import-v31",
        abstract: "Migrate a Bun v31 SQLite database into a clean Swift v1 corpus."
    )

    @Argument(help: "Path to the legacy Bun v31 SQLite database.")
    var legacyDatabasePath: String

    @Option(name: .shortAndLong, help: "Destination Swift v1 SQLite database path.")
    var destinationPath: String?

    @Flag(name: .long, help: "Skip copying compressed document_raw blobs.")
    var skipRaw = false

    @Flag(name: .long, help: "Skip rebuilding body and symbol FTS5 indexes.")
    var skipFTS = false

    func run() throws {
        let resolvedDestination = destinationPath ?? CorpusPaths.defaultDatabasePath()
        let store = try CorpusStore(path: resolvedDestination, options: .readWrite)
        defer { store.close() }
        let report = try LegacyV31Importer.importDatabase(
            from: legacyDatabasePath,
            into: store,
            includeRawPayloads: !skipRaw,
            rebuildFTS: !skipFTS
        )
        let summary = [
            "schema: v\(report.sourceSchemaVersion) -> v\(CorpusSchemaV1.userVersion)",
            "output: \(resolvedDestination)",
            "roots: \(report[.roots])",
            "documents: \(report[.documents])",
            "sections: \(report[.sections])",
            "relationships: \(report[.relationships])",
            "sf_symbols: \(report[.sfSymbols])",
            "fonts: \(report[.fontFamilies]) families / \(report[.fontFiles]) files"
        ]
        print(summary.joined(separator: "\n"))
    }
}

import AppleDocsCommands
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// `apple-docs symbols [query]` subcommand searching indexed SF Symbols.
struct SymbolsSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "symbols",
        abstract: "Search indexed SF Symbols by name, keyword, category, or alias."
    )

    // @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape
    @Argument(help: "Optional search query (empty lists symbols in catalog order).")
    var query = ""

    @Option(name: .shortAndLong, help: "Symbol scope: public or private.")
    var scope = "public"

    @Option(name: .shortAndLong, help: "Maximum symbols to return.")
    var limit = 50

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        try common.runQuery { store in
            try AssetQueryService.searchSFSymbols(
                query: query,
                scope: scope,
                limit: limit,
                on: store.connection
            )
        } formatText: { symbols in
            PublicTextFormatter.renderTable(
                symbols.map { [$0.name, $0.scope, $0.categories.joined(separator: ",")] }
            )
        }
    }
}

// @dl:accept -- ArgumentParser @Option declarations share the ParsableCommand shape across subcommands
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch
import AppleDocsStorage
import ArgumentParser

/// `apple-docs search <query>` subcommand with framework, kind, language, deprecation, and OS filters.
// @dl:accept -- ArgumentParser @Option property declarations share the ParsableCommand shape
struct SearchSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "search",
        abstract: "Search indexed documentation across frameworks, HIG, WWDC, and Swift docs."
    )

    @Argument(help: "Search query text, symbol name, path, or USR.")
    var query: String

    @Option(name: .shortAndLong, help: "Filter by framework or collection slug.")
    var framework: String?

    @Option(name: .shortAndLong, help: "Filter by symbol kind or role heading.")
    var kind: String?

    @Option(name: .long, help: "Filter by language (swift or objc).")
    var language: String?

    @Option(name: .long, help: "Maximum iOS version availability (e.g. 17.0).")
    var ios: String?

    @Option(name: .long, help: "Maximum macOS version availability (e.g. 15.0).")
    var macos: String?

    @Flag(name: .long, help: "Exclude deprecated symbols.")
    var excludeDeprecated = false

    @Option(name: .shortAndLong, help: "Maximum results to return.")
    var limit = 25

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        let request = CorpusSearchRequest(
            query: query,
            framework: framework,
            kind: kind,
            language: language,
            deprecated: excludeDeprecated ? .exclude : .include,
            minVersions: PlatformAvailability(ios: ios, macos: macos),
            limit: limit
        )
        try common.runQuery(
            { try CorpusQueryService.search(request, on: $0.connection) },
            formatText: PublicTextFormatter.formatSearchResults
        )
    }
}

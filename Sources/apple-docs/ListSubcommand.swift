// @dl:accept -- ArgumentParser @Option declarations share the ParsableCommand shape across subcommands
import AppleDocsCommands
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// `apple-docs list` subcommand listing indexed frameworks and collections.
struct ListSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "list",
        abstract: "List indexed frameworks, HIG collections, and WWDC roots."
    )

    // @dl:accept -- ArgumentParser @Option property declarations share the ParsableCommand shape
    @Option(name: .long, help: "Filter by root kind (framework, collection, design, ...).")
    var kind: String?

    @Option(name: .long, help: "Browse children under a specific framework slug instead of listing roots.")
    var browse: String?

    @Option(name: .shortAndLong, help: "Maximum rows to display when browsing.")
    var limit = 100

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        if let framework = browse {
            try common.runQuery { store in
                try CorpusQueryService.browse(framework: framework, limit: limit, on: store.connection)
            } formatText: { entries in
                PublicTextFormatter.renderTable(entries.map { [$0.path, $0.title] })
            }
            return
        }
        try common.runQuery(
            { try CorpusQueryService.listFrameworks(kind: kind, on: $0) },
            formatText: PublicTextFormatter.formatFrameworks
        )
    }
}

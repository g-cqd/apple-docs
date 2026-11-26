import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import ArgumentParser

/// `apple-docs read <path-or-symbol>` subcommand.
struct ReadSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "read",
        abstract: "Read a documentation page."
    )

    @Argument(help: "Document key (e.g. swiftui/navigationstack) or symbol name.")
    var target: String

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        try common.runQuery { store -> PublicDocumentDetail in
            let found: PublicDocumentDetail? =
                if let key = try? DocumentKey(target), target.contains("/") {
                    try CorpusQueryService.readDocument(key: key, on: store)
                } else {
                    try CorpusQueryService.readSymbol(named: target, on: store)
                }
            guard let detail = found else { throw ExitCode.failure }
            return detail
        } formatText: { detail in
            detail.renderMarkdown()
        }
    }
}

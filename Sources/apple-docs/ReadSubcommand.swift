import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// `apple-docs read <path-or-symbol>` subcommand supporting `--section` and `--match` excerpts.
struct ReadSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "read",
        abstract: "Read a documentation page, a single section by heading, or substring match excerpts."
    )

    @Argument(help: "Document key (e.g. swiftui/navigationstack) or symbol name.")
    var target: String

    @Option(name: .long, help: "Extract only the section matching this heading.")
    var section: String?

    @Option(name: .long, help: "Return excerpt windows around matches of this substring.")
    var match: String?

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        if let matchQuery = match, !matchQuery.isEmpty {
            try common.runQuery { store -> [PublicMatchExcerpt] in
                guard let detail = try resolveDetail(in: store) else { throw ExitCode.failure }
                return detail.matchExcerpts(query: matchQuery)
            } formatText: { excerpts in
                excerpts.map { "[\($0.sectionHeading ?? "Overview")] \($0.excerpt)" }.joined(separator: "\n\n")
            }
            return
        }
        try common.runQuery { store -> PublicDocumentDetail in
            guard let detail = try resolveDetail(in: store) else { throw ExitCode.failure }
            return detail
        } formatText: { detail in
            detail.renderMarkdown(sectionHeading: section) ?? ""
        }
    }

    private func resolveDetail(in store: CorpusStore) throws -> PublicDocumentDetail? {
        if let key = try? DocumentKey(target), target.contains("/") {
            return try CorpusQueryService.readDocument(key: key, on: store)
        }
        return try CorpusQueryService.readSymbol(named: target, on: store)
    }
}

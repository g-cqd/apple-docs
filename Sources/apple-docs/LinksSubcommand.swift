import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import ArgumentParser

/// `apple-docs links <key>` subcommand querying incoming and/or outgoing document relationships.
struct LinksSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "links",
        abstract: "Show incoming and outgoing documentation relationships for a document key."
    )

    // @dl:accept -- ArgumentParser @Argument/@Option declarations share the ParsableCommand shape
    @Argument(help: "Canonical document key (e.g. swiftui/navigationstack).")
    var target: String

    // @dl:accept -- ArgumentParser @Option declarations share the ParsableCommand shape
    @Option(name: .shortAndLong, help: "Direction: outgoing, incoming, or both.")
    var direction = "both"

    @Option(name: .shortAndLong, help: "Maximum links to return.")
    var limit = 100

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        let key = try DocumentKey(target)
        guard let dir = CorpusQueryService.LinkDirection(rawValue: direction.lowercased()) else {
            throw ValidationError("Invalid direction '\(direction)'; expected outgoing, incoming, or both.")
        }
        try common.runQuery { store in
            try CorpusQueryService.links(forKey: key, direction: dir, limit: limit, on: store)
        } formatText: { links in
            PublicTextFormatter.renderTable(links.map { [$0.from, $0.relationType, $0.to] })
        }
    }
}

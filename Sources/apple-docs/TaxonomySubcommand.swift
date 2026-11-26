// @dl:accept -- ArgumentParser query subcommand shares standard import & ParsableCommand shape
import AppleDocsCommands
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// `apple-docs taxonomy` subcommand displaying distinct taxonomy buckets and counts.
// @dl:accept -- ArgumentParser ParsableCommand @Option boilerplate
struct TaxonomySubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "taxonomy",
        abstract: "List distinct taxonomy values (kind, role, role_heading, source_type, framework) with counts."
    )

    @Option(name: .shortAndLong, help: "Taxonomy field (kind, role, role_heading, source_type, framework).")
    var field = "kind"
    @Flag(name: .long, help: "Show full distribution instead of top 20.") var all = false
    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        guard let parsedField = CorpusQueryService.TaxonomyField(rawValue: field) else {
            throw ValidationError("Unsupported taxonomy field '\(field)'.")
        }
        let limit = all ? 500 : 20
        try common.runQuery { store in
            try CorpusQueryService.listTaxonomy(field: parsedField, limit: limit, on: store.connection)
        } formatText: { buckets in
            PublicTextFormatter.renderTable(buckets.map { [$0.value, String($0.count)] })
        }
    }
}

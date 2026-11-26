import AppleDocsCommands
import AppleDocsOutput
import AppleDocsStorage
import ArgumentParser

/// `apple-docs fonts` subcommand listing indexed Apple font families and files.
struct FontsSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "fonts",
        abstract: "List indexed Apple font families and file IDs."
    )

    @OptionGroup var common: QueryCLIOptions

    func run() throws {
        try common.runQuery { store in
            try AssetQueryService.listAppleFonts(on: store.connection)
        } formatText: { families in
            PublicTextFormatter.renderTable(
                families.map { [$0.id, $0.displayName, "\($0.files.count) files"] }
            )
        }
    }
}

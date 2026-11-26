import AppleDocsCore
import ArgumentParser

/// Root CLI entry point for `apple-docs`.
@main
struct AppleDocsCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "apple-docs",
        abstract: "Offline Apple developer documentation CLI, MCP server, and local website.",
        version: AppleDocsVersion.current,
        subcommands: [
            StatusSubcommand.self,
            SearchSubcommand.self,
            ReadSubcommand.self,
            ListSubcommand.self,
            TaxonomySubcommand.self,
            LinksSubcommand.self,
            SymbolsSubcommand.self,
            FontsSubcommand.self,
            ImportV31Subcommand.self,
            SnapshotSubcommand.self,
            SetupSubcommand.self,
            SyncSubcommand.self,
            ConsolidateSubcommand.self,
            MCPSubcommand.self,
            WebSubcommand.self
        ]
    )
}

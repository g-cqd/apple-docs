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
            ImportV31Subcommand.self,
            MCPSubcommand.self
        ]
    )
}

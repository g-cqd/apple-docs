import AppleDocsCommands
import AppleDocsCore
import AppleDocsSetup
import ArgumentParser

/// Root CLI entry point for `apple-docs`.
@main
struct AppleDocsCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "apple-docs",
        abstract: "Offline Apple developer documentation CLI, MCP server, and local website.",
        version: AppleDocsVersion.current,
        subcommands: [StatusSubcommand.self]
    )
}

private struct StatusSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "status",
        abstract: "Show version and host setup capability summary."
    )

    func run() {
        let status = RuntimeStatus()
        print("apple-docs \(status.version)")
        print("snapshot-install: \(status.capabilities.supportsSnapshotInstall)")
        print("darwin-assets: \(status.capabilities.supportsCoreGlyphsPrerender)")
    }
}

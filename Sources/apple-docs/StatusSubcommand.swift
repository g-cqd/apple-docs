import AppleDocsCommands
import AppleDocsSetup
import ArgumentParser

/// `apple-docs status` subcommand showing runtime version and host setup capabilities.
struct StatusSubcommand: ParsableCommand {
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

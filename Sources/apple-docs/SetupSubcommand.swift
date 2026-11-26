import AppleDocsCommands
import AppleDocsSetup
import AppleDocsSetupDarwin
import AppleDocsStorage
import ArgumentParser

/// `apple-docs setup` command group (host capability diagnostics & macOS CoreGlyphs catalog sync).
struct SetupSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "setup",
        abstract: "Inspect host authoring capabilities or synchronize macOS CoreGlyphs SF Symbols.",
        subcommands: [
            SetupDoctorSubcommand.self,
            SetupSyncSymbolsSubcommand.self
        ],
        defaultSubcommand: SetupDoctorSubcommand.self
    )
}

private struct SetupDoctorSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "doctor",
        abstract: "Report cross-platform and macOS-only authoring bundle availability."
    )

    func run() {
        let caps = DarwinSetupHost.capabilities
        let bundles = DarwinAssetLocator.discover()
        print("snapshot-install: \(caps.supportsSnapshotInstall)")
        print("upstream-crawl: \(caps.supportsUpstreamCrawl)")
        print("darwin-coreglyphs: \(bundles.coreGlyphsBundlePath ?? "unavailable")")
        print("darwin-sf-symbols-app: \(bundles.sfSymbolsAppPath ?? "unavailable")")
        print("darwin-xcode-cache: \(bundles.xcodeDocumentationCachePath ?? "unavailable")")
    }
}

// @dl:accept -- ArgumentParser subcommand declarations share the ParsableCommand shape
private struct SetupSyncSymbolsSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-symbols",
        abstract: "Synchronize SF Symbols metadata from macOS CoreGlyphs.bundle into a Swift v1 corpus."
    )

    @Option(name: .long, help: "Target Swift v1 corpus database path.")
    var db: String?

    @Option(name: .long, help: "Optional explicit path to CoreGlyphs.bundle.")
    var bundle: String?

    func run() throws {
        let store = try CorpusStore(path: db ?? CorpusPaths.defaultDatabasePath(), options: .readWrite)
        defer { store.close() }
        let report = try DarwinCoreGlyphsSync.sync(into: store, bundlePath: bundle)
        print("Synced \(report.symbolsSynced) SF Symbols from \(report.bundlePath)")
    }
}

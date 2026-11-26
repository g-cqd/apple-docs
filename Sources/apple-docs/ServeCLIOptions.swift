import AppleDocsCommands
import ArgumentParser

/// Shared bind host, port, and database path flags for `mcp serve` and `web serve`.
struct ServeCLIOptions: ParsableArguments {
    @Option(name: .long, help: "Bind host address.") var host = "127.0.0.1"
    @Option(name: .long, help: "TCP listen port.") var port: UInt16?
    @Option(name: .long, help: "Override corpus database path.") var db: String?

    var resolvedDatabasePath: String {
        db ?? CorpusPaths.defaultDatabasePath()
    }
}

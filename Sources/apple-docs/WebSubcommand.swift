import AppleDocsWeb
import ArgumentParser

/// `apple-docs web` command group (`serve` runs the local SSR + JSON API server on `g-cqd/HTTP`).
struct WebSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "web",
        abstract: "Serve the local Apple documentation website and JSON API.",
        subcommands: [WebServeSubcommand.self]
    )
}

private struct WebServeSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "serve",
        abstract: "Start the local SSR website and read-only JSON API server via g-cqd/HTTP."
    )

    @OptionGroup var server: ServeCLIOptions

    func run() async throws {
        try await WebHTTPServer.serve(
            databasePath: server.resolvedDatabasePath,
            host: server.host,
            port: server.port ?? 3_134
        )
    }
}

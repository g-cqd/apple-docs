import AppleDocsCommands
import AppleDocsWeb
import ArgumentParser

/// `apple-docs web` command group (`serve` runs the local SSR server; `build` exports a static site).
struct WebSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "web",
        abstract: "Serve the local Apple documentation website or export a static site.",
        subcommands: [WebServeSubcommand.self, WebBuildSubcommand.self]
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

private struct WebBuildSubcommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "build",
        abstract: "Export a self-contained static HTML & JSON documentation site."
    )

    @Argument(help: "Output directory for the generated static site.")
    var outputDirectory: String

    @Option(name: .shortAndLong, help: "Optional framework slug filter.")
    var framework: String?

    @Option(name: .long, help: "Maximum number of document pages to export.")
    var maxPages = 1_000

    @OptionGroup var server: ServeCLIOptions

    func run() throws {
        let report = try StaticSiteBuilder.build(
            databasePath: server.resolvedDatabasePath,
            outputDirectory: outputDirectory,
            framework: framework,
            limit: maxPages
        )
        print("Built static site in \(report.outputDirectory)")
        print("frameworks: \(report.frameworksExported), pages: \(report.pagesExported)")
    }
}

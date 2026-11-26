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

    @Option(name: .long, help: "Public origin used in sitemap URLs (default: http://<host>:<port>).")
    var baseURL: String?

    @Option(name: .long, help: "Override the resources directory (SF Symbol SVGs, fonts).")
    var resources: String?

    func run() async throws {
        try await WebHTTPServer.serve(
            databasePath: server.resolvedDatabasePath,
            resourcesDirectory: resources,
            site: baseURL.map { WebSiteConfiguration(baseURL: $0) },
            host: server.host,
            port: server.port ?? 3_134,
            options: server.serverOptions
        )
    }
}

private struct WebBuildSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "build",
        abstract: "Export a self-contained static HTML documentation site (replaced atomically on rebuild)."
    )

    @Argument(help: "Output directory for the generated static site.")
    var outputDirectory: String

    @Option(name: .shortAndLong, help: "Optional framework slug filter.")
    var framework: String?

    @Option(name: .long, help: "Maximum number of document pages to export.")
    var maxPages = 1_000

    @Option(name: .long, help: "Public origin used in sitemap URLs.")
    var baseURL = "http://127.0.0.1:3134"

    @Option(name: .long, help: "Parallel page renderers.")
    var concurrency = 8

    @Option(name: .long, help: "Override the resources directory (SF Symbol SVGs).")
    var resources: String?

    @Option(name: .long, help: "Override corpus database path.")
    var db: String?

    func run() async throws {
        let report = try await StaticSiteBuilder.build(
            databasePath: db ?? CorpusPaths.defaultDatabasePath(),
            outputDirectory: outputDirectory,
            options: StaticSiteBuilder.Options(
                framework: framework,
                limit: maxPages,
                site: WebSiteConfiguration(baseURL: baseURL),
                resourcesDirectory: resources,
                concurrency: concurrency
            )
        )
        print("Built static site in \(report.outputDirectory)")
        print("frameworks: \(report.frameworksExported), pages: \(report.pagesExported), failures: \(report.failures)")
    }
}

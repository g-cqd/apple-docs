import AppleDocsCommands
import ArgumentParser

/// Shared bind host, port, database path, and serving-chain flags for `mcp serve` and `web serve`.
struct ServeCLIOptions: ParsableArguments {
    @Option(name: .long, help: "Bind host address.") var host = "127.0.0.1"
    @Option(name: .long, help: "TCP listen port.") var port: UInt16?
    @Option(name: .long, help: "Override corpus database path.") var db: String?
    @Option(name: .long, help: "Requests per minute allowed per client address.") var rateLimit = 300
    @Flag(
        name: .long,
        inversion: .prefixedNo,
        help: "Expose Prometheus metrics at /metrics (default: only on loopback binds)."
    )
    var metrics: Bool?

    var resolvedDatabasePath: String {
        db ?? CorpusPaths.defaultDatabasePath()
    }

    var serverOptions: PlatformHTTPServer.Options {
        PlatformHTTPServer.Options(
            rateLimitPerMinute: max(1, rateLimit),
            exposeMetrics: metrics ?? PlatformHTTPServer.isLoopback(host)
        )
    }
}

public import AemiHTTP

/// Shared cross-platform `g-cqd/HTTP` server bootstrapper using `TransportBackbone.recommended`
/// (`posixKqueue` on Darwin, `posixEpoll` on Linux) behind one serving chain, outermost first:
/// request ID → per-peer rate limit (fail-closed bounded LRU) → RED metrics → optional `/metrics` →
/// security headers → `Date` → conditional requests (`ETag`/`304`) → content coding (br/gzip).
public enum PlatformHTTPServer: Sendable {
    /// Serving-chain settings.
    public struct Options: Sendable {
        public var rateLimitPerMinute: Int
        public var contentSecurityPolicy: String?
        /// Serve the Prometheus exposition at `/metrics`.
        public var exposeMetrics: Bool
        /// Responses smaller than this many bytes are sent uncompressed.
        public var compressionMinimumSize: Int

        public init(
            rateLimitPerMinute: Int = 300,
            contentSecurityPolicy: String? = "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
            exposeMetrics: Bool = false,
            compressionMinimumSize: Int = 1_024
        ) {
            self.rateLimitPerMinute = rateLimitPerMinute
            self.contentSecurityPolicy = contentSecurityPolicy
            self.exposeMetrics = exposeMetrics
            self.compressionMinimumSize = compressionMinimumSize
        }
    }

    /// Route prefixes used as bounded metrics labels for both the web and MCP servers.
    // @dl:disable -- declarative route list
    public static let metricRoutes = [
        "/", "/doc", "/search", "/symbols", "/fonts", "/assets", "/sitemap.xml", "/sitemaps", "/api/search",
        "/api/doc", "/api/frameworks", "/api/symbols", "/api/fonts", "/mcp", "/healthz", "/readyz", "/metrics",
        "/.well-known"
    ]
    // @dl:enable

    /// `responder` wrapped in the standard serving chain (exposed for in-process tests).
    public static func servingChain(
        for responder: any HTTPResponder,
        options: Options,
        metrics: HTTPMetricsRegistry
    ) -> any HTTPResponder {
        var chain: [any HTTPMiddleware] = [
            RequestIDMiddleware(),
            RateLimitMiddleware(
                limit: max(1, options.rateLimitPerMinute),
                per: .seconds(60),
                maxTrackedClients: 16_384
            ),
            MetricsMiddleware(metrics)
        ]
        if options.exposeMetrics { chain.append(MetricsEndpointMiddleware(registry: metrics)) }
        chain += [
            SecurityHeadersMiddleware(
                contentTypeOptions: true,
                frameOptions: "DENY",
                referrerPolicy: "no-referrer",
                contentSecurityPolicy: options.contentSecurityPolicy
            ),
            DateHeaderMiddleware(),
            ConditionalRequestMiddleware(),
            CompressionMiddleware(minimumSize: options.compressionMinimumSize)
        ]
        return responder.wrapped(by: chain)
    }

    /// Binds `host:port`, serves `responder` through ``servingChain(for:options:metrics:)``, and guarantees
    /// `onShutdown` runs on exit.
    public static func serve(
        responder: any HTTPResponder,
        host: String,
        port: UInt16,
        options: Options = Options(),
        onShutdown: @Sendable () async -> Void
    ) async throws {
        let chain = servingChain(
            for: responder,
            options: options,
            metrics: HTTPMetricsRegistry(routes: metricRoutes)
        )
        let transport = try TransportFactory.make(
            TransportConfiguration(host: host, port: port, backbone: .recommended)
        )
        let server = HTTPServer(transport: transport, responder: chain)
        do {
            try await server.run()
            await onShutdown()
        } catch {
            await onShutdown()
            throw error
        }
    }

    /// Whether `host` is a loopback bind address (metrics default to exposed only there).
    public static func isLoopback(_ host: String) -> Bool {
        host == "127.0.0.1" || host == "::1" || host == "localhost" || host.hasPrefix("127.")
    }
}

public import AemiHTTP

/// Shared cross-platform `g-cqd/HTTP` server bootstrapper using `TransportBackbone.recommended`
/// (`posixKqueue` on Darwin, `posixEpoll` on Linux) wrapped with `g-cqd/HTTP`'s built-in
/// `RequestIDMiddleware`, `RateLimitMiddleware` (fail-closed per-peer bounded LRU), and
/// `SecurityHeadersMiddleware`.
public enum PlatformHTTPServer: Sendable {
    /// Binds `host:port` with `TransportBackbone.recommended`, wraps `responder` in standard
    /// request-ID, per-IP rate-limiting, and security-header middleware, and guarantees `onShutdown` runs on exit.
    public static func serve(
        responder: any HTTPResponder,
        host: String,
        port: UInt16,
        rateLimitPerMinute: Int = 300,
        contentSecurityPolicy: String? = "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
        onShutdown: @Sendable () async -> Void
    ) async throws {
        let hardened = responder.wrapped(by: [
            RequestIDMiddleware(),
            RateLimitMiddleware(
                limit: max(1, rateLimitPerMinute),
                per: .seconds(60),
                maxTrackedClients: 16_384
            ),
            SecurityHeadersMiddleware(
                contentTypeOptions: true,
                frameOptions: "DENY",
                referrerPolicy: "no-referrer",
                contentSecurityPolicy: contentSecurityPolicy
            )
        ])
        let transport = try TransportFactory.make(
            TransportConfiguration(host: host, port: port, backbone: .recommended)
        )
        let server = HTTPServer(transport: transport, responder: hardened)
        do {
            try await server.run()
            await onShutdown()
        } catch {
            await onShutdown()
            throw error
        }
    }
}

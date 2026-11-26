public import AemiHTTP

/// Shared cross-platform `g-cqd/HTTP` server bootstrapper (`posixKqueue` on Darwin, `posixEpoll` on Linux)
/// used by both `AppleDocsMCP` and `AppleDocsWeb`.
public enum PlatformHTTPServer: Sendable {
    /// Selects the native high-performance event-loop backbone for the active OS.
    public static var defaultBackbone: TransportBackbone {
        #if os(Linux)
            .posixEpoll
        #else
            .posixKqueue
        #endif
    }

    /// Binds `host:port` with `defaultBackbone`, runs `responder`, and guarantees `onShutdown` runs.
    public static func serve(
        responder: any HTTPResponder,
        host: String,
        port: UInt16,
        onShutdown: @Sendable () async -> Void
    ) async throws {
        let transport = try TransportFactory.make(
            TransportConfiguration(host: host, port: port, backbone: defaultBackbone)
        )
        let server = HTTPServer(transport: transport, responder: responder)
        do {
            try await server.run()
            await onShutdown()
        } catch {
            await onShutdown()
            throw error
        }
    }
}

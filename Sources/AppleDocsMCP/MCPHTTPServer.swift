public import AemiHTTP

/// Runs ``MCPHTTPResponder`` on `g-cqd/HTTP`'s cross-platform `HTTPServer`
/// (`posixKqueue` on Darwin, `posixEpoll` on Linux) with clean graceful shutdown.
public enum MCPHTTPServer: Sendable {
    /// Selects the native high-performance event-loop backbone for the active OS.
    public static var platformBackbone: TransportBackbone {
        #if os(Linux)
            .posixEpoll
        #else
            .posixKqueue
        #endif
    }

    /// Starts the HTTP listener on `host:port` until cancelled.
    public static func serve(
        dispatcher: MCPServerDispatcher,
        host: String = "127.0.0.1",
        port: UInt16 = 3_133,
        allowedOrigins: Set<String> = []
    ) async throws {
        let responder = MCPHTTPResponder(dispatcher: dispatcher, allowedOrigins: allowedOrigins)
        let transport = try TransportFactory.make(
            TransportConfiguration(host: host, port: port, backbone: platformBackbone)
        )
        let server = HTTPServer(transport: transport, responder: responder)
        do {
            try await server.run()
            await dispatcher.close()
        } catch {
            await dispatcher.close()
            throw error
        }
    }
}

public import AppleDocsCommands

/// Runs ``MCPHTTPResponder`` on ``PlatformHTTPServer`` with clean graceful shutdown.
public enum MCPHTTPServer: Sendable {
    /// Starts the HTTP listener on `host:port` until cancelled.
    public static func serve(
        dispatcher: MCPServerDispatcher,
        host: String = "127.0.0.1",
        port: UInt16 = 3_133,
        allowedOrigins: Set<String> = [],
        options: PlatformHTTPServer.Options = PlatformHTTPServer.Options()
    ) async throws {
        dispatcher.prewarm()
        let responder = MCPHTTPResponder(dispatcher: dispatcher, allowedOrigins: allowedOrigins)
        try await PlatformHTTPServer.serve(responder: responder, host: host, port: port, options: options) {
            await dispatcher.close()
        }
    }
}

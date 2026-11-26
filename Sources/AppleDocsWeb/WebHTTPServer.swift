import AppleDocsCommands

/// Runs ``WebHTTPResponder`` on ``PlatformHTTPServer`` with clean graceful shutdown.
public enum WebHTTPServer: Sendable {
    /// Starts the local web server on `host:port` until cancelled.
    public static func serve(
        databasePath: String,
        host: String = "127.0.0.1",
        port: UInt16 = 3_134
    ) async throws {
        let responder = WebHTTPResponder(databasePath: databasePath)
        try await PlatformHTTPServer.serve(responder: responder, host: host, port: port) {
            await responder.close()
        }
    }
}

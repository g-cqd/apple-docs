public import AppleDocsCommands

/// Runs ``WebHTTPResponder`` on ``PlatformHTTPServer`` with clean graceful shutdown.
public enum WebHTTPServer: Sendable {
    /// Starts the local web server on `host:port` until cancelled.
    public static func serve(
        databasePath: String,
        resourcesDirectory: String? = nil,
        site: WebSiteConfiguration? = nil,
        host: String = "127.0.0.1",
        port: UInt16 = 3_134,
        options: PlatformHTTPServer.Options = PlatformHTTPServer.Options()
    ) async throws {
        let responder = WebHTTPResponder(
            databasePath: databasePath,
            resourcesDirectory: resourcesDirectory,
            site: site ?? WebSiteConfiguration(baseURL: "http://\(host.contains(":") ? "[\(host)]" : host):\(port)")
        )
        responder.reader.prewarmSemantic()
        try await PlatformHTTPServer.serve(responder: responder, host: host, port: port, options: options) {
            await responder.close()
        }
    }
}

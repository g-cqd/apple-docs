public import AemiHTTP

/// Hardened Streamable HTTP responder for the MCP endpoint (`POST /mcp`) running on `g-cqd/HTTP`.
///
/// Enforces:
/// - Default-deny `Origin` policy (allows loopback origins or explicit allowlist; rejects cross-site browser requests with `403` to prevent DNS rebinding / CSRF — Threat Model T-06).
/// - Strict request body size cap (1 MiB default — Threat Model T-04).
/// - Strict JSON-RPC 2.0 single-object dispatch (batch arrays rejected with `-32600`).
/// - Dedicated `/healthz` probe returning `200 OK`.
public struct MCPHTTPResponder: HTTPResponder, Sendable {
    /// Maximum accepted HTTP request body size (1 MiB).
    public static let defaultMaxBodyBytes = 1_048_576

    private let dispatcher: MCPServerDispatcher
    private let allowedOrigins: Set<String>
    private let maxBodyBytes: Int

    public init(
        dispatcher: MCPServerDispatcher,
        allowedOrigins: Set<String> = [],
        maxBodyBytes: Int = defaultMaxBodyBytes
    ) {
        self.dispatcher = dispatcher
        self.allowedOrigins = allowedOrigins
        self.maxBodyBytes = maxBodyBytes
    }

    public func respond(
        to request: HTTPRequest,
        body: RequestBody,
        context: RequestContext
    ) async -> ServerResponse {
        let path = request.path
        if request.method == .get, path == "/healthz" {
            return .json(Array("{\"status\":\"ok\"}".utf8), status: .ok)
        }
        guard path == "/mcp" else {
            return .status(.notFound)
        }
        guard request.method == .post else {
            return .status(.methodNotAllowed)
        }
        if let origin = request.headerFields[.origin], !Self.isAllowedOrigin(origin, allowlist: allowedOrigins) {
            return .text("Origin not allowed.", status: .forbidden)
        }

        guard let payload = await body.collect(maximum: maxBodyBytes) else {
            return .text("Request body exceeds \(maxBodyBytes) bytes.", status: .contentTooLarge)
        }

        guard let reply = await dispatcher.handleRawPayload(payload) else {
            return .status(.accepted)
        }
        return .json(reply, status: .ok)
    }

    /// Validates an inbound HTTP `Origin` header against loopback defaults plus explicit `allowlist`.
    public static func isAllowedOrigin(_ origin: String, allowlist: Set<String>) -> Bool {
        let trimmed = origin.lowercased()
        if allowlist.contains(trimmed) { return true }
        let loopbackPrefixes = [
            "http://localhost", "https://localhost",
            "http://127.0.0.1", "https://127.0.0.1",
            "http://[::1]", "https://[::1]"
        ]
        for prefix in loopbackPrefixes where trimmed == prefix || trimmed.hasPrefix("\(prefix):") {
            return true
        }
        return false
    }
}

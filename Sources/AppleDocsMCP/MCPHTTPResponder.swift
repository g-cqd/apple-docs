public import AemiHTTP
import AemiMCPHTTP

/// Hardened Streamable HTTP responder for the MCP endpoint (`POST /mcp`) running on `g-cqd/HTTP`: AemiMCPHTTP's
/// responder over this dispatcher.
///
/// Enforces:
/// - Default-deny `Origin` policy (allows loopback origins or explicit allowlist; rejects cross-site browser requests with `403` to prevent DNS rebinding / CSRF — Threat Model T-06).
/// - Strict request body size cap (1 MiB default — Threat Model T-04).
/// - Strict JSON-RPC 2.0 single-object dispatch (batch arrays rejected with `-32600`).
/// - Dedicated `/healthz` probe returning `200 OK`.
public struct MCPHTTPResponder: HTTPResponder, Sendable {
    /// Maximum accepted HTTP request body size (1 MiB).
    public static let defaultMaxBodyBytes = AemiMCPHTTP.MCPHTTPResponder.defaultMaxBodyBytes

    private let responder: AemiMCPHTTP.MCPHTTPResponder

    public init(
        dispatcher: MCPServerDispatcher,
        allowedOrigins: Set<String> = [],
        maxBodyBytes: Int = defaultMaxBodyBytes
    ) {
        responder = AemiMCPHTTP.MCPHTTPResponder(
            server: dispatcher.protocolHandler,
            allowedOrigins: allowedOrigins,
            maxBodyBytes: maxBodyBytes
        )
    }

    public func respond(to request: HTTPRequest, body: RequestBody, context: RequestContext) async -> ServerResponse {
        await responder.respond(to: request, body: body, context: context)
    }

    /// Validates an inbound HTTP `Origin` header against loopback defaults plus explicit `allowlist`.
    public static func isAllowedOrigin(_ origin: String, allowlist: Set<String>) -> Bool {
        AemiMCPHTTP.MCPHTTPResponder.isAllowedOrigin(origin, allowlist: allowlist)
    }
}

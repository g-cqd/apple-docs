/// Descriptor for a well-known discovery or health HTTP endpoint on `apple-docs web serve`.
public struct WebDiscoveryEndpoint: Hashable, Sendable {
    public let path: String
    public let contentType: String

    public init(path: String, contentType: String) {
        self.path = path
        self.contentType = contentType
    }

    /// Standard endpoints mounted by the web server.
    public static let standard: [Self] = [
        Self(path: "/robots.txt", contentType: "text/plain; charset=utf-8"),
        Self(path: "/.well-known/api-catalog", contentType: "application/linkset+json"),
        Self(path: "/.well-known/mcp/server-card.json", contentType: "application/json; charset=utf-8"),
        Self(path: "/.well-known/security.txt", contentType: "text/plain; charset=utf-8"),
        Self(path: "/healthz", contentType: "application/json; charset=utf-8"),
        Self(path: "/readyz", contentType: "application/json; charset=utf-8")
    ]
}

/// Single outbound HTTP fetch request executed by ``UpstreamHTTPTransport``.
public struct UpstreamFetchRequest: Hashable, Sendable {
    public let url: String
    public let method: String
    public let ifNoneMatch: String?
    public let ifModifiedSince: String?
    public let accept: String
    public let headers: [String: String]
    public let maxBodyBytes: Int

    public init(
        url: String,
        method: String = "GET",
        ifNoneMatch: String? = nil,
        ifModifiedSince: String? = nil,
        accept: String = "application/json, text/html, text/markdown;q=0.9, */*;q=0.5",
        headers: [String: String] = [:],
        maxBodyBytes: Int = 16_777_216
    ) {
        self.url = url
        self.method = method
        self.ifNoneMatch = ifNoneMatch
        self.ifModifiedSince = ifModifiedSince
        self.accept = accept
        self.headers = headers
        self.maxBodyBytes = max(1_024, maxBodyBytes)
    }
}

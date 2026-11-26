/// Response returned by ``UpstreamHTTPTransport`` for one conditional or unconditional GET.
public struct UpstreamFetchResponse: Hashable, Sendable {
    public let statusCode: Int
    public let body: [UInt8]
    public let etag: String?
    public let lastModified: String?
    public let contentType: String?
    public let retryAfterSeconds: Int?

    public init(
        statusCode: Int,
        body: [UInt8] = [],
        etag: String? = nil,
        lastModified: String? = nil,
        contentType: String? = nil,
        retryAfterSeconds: Int? = nil
    ) {
        self.statusCode = statusCode
        self.body = body
        self.etag = etag
        self.lastModified = lastModified
        self.contentType = contentType
        self.retryAfterSeconds = retryAfterSeconds
    }

    /// `true` when the server responded `304 Not Modified`.
    public var isNotModified: Bool { statusCode == 304 }

    /// `true` when the server responded `404` or `410`.
    public var isDeleted: Bool { statusCode == 404 || statusCode == 410 }
}

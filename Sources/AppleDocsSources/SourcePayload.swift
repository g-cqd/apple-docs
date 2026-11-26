public import AppleDocsCore

/// Single normalized item yielded by any ``SourceAdapter`` for ingestion by ``SyncPipeline``.
public struct SourcePayload: Hashable, Sendable {
    /// Wire encoding of ``body``.
    public enum Encoding: String, Hashable, Sendable, Codable {
        case doccJSON
        case html
        case markdown
    }

    public let key: DocumentKey
    public let sourceType: SourceKind
    public let fallbackTitle: String
    public let url: String?
    public let encoding: Encoding
    public let body: [UInt8]

    public init(
        key: DocumentKey,
        sourceType: SourceKind,
        fallbackTitle: String,
        url: String? = nil,
        encoding: Encoding,
        body: [UInt8]
    ) {
        self.key = key
        self.sourceType = sourceType
        self.fallbackTitle = fallbackTitle
        self.url = url
        self.encoding = encoding
        self.body = body
    }
}

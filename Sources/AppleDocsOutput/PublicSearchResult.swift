public import AppleDocsCore

/// Public search result payload serialized across CLI `--json`, MCP `search_docs`, and Web `/api/search`.
public struct PublicSearchResult: Hashable, Sendable, Codable {
    public let document: PublicDocumentMetadata
    public let confidence: String

    public init(document: DocumentRecord, confidence: String) {
        self.document = PublicDocumentMetadata(from: document)
        self.confidence = confidence
    }

    public var path: String { document.path }
    public var title: String { document.title }
    public var framework: String { document.framework }
}

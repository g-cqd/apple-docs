public import AppleDocsCore

/// Structured search request with typed filters pushed down to SQLite and `AemiSearch`.
public struct CorpusSearchRequest: Hashable, Sendable {
    /// Handling of deprecated documentation items.
    public enum DeprecatedFilter: String, Hashable, Sendable, Codable {
        case include
        case exclude
        case only
    }

    public let query: String
    public let framework: String?
    public let kind: String?
    public let language: String?
    public let sources: [SourceKind]
    public let deprecated: DeprecatedFilter
    public let minVersions: PlatformAvailability
    public let limit: Int

    public init(
        query: String,
        framework: String? = nil,
        kind: String? = nil,
        language: String? = nil,
        sources: [SourceKind] = [],
        deprecated: DeprecatedFilter = .include,
        minVersions: PlatformAvailability = .none,
        limit: Int = 25
    ) {
        self.query = query
        self.framework = framework
        self.kind = kind
        self.language = language
        self.sources = sources
        self.deprecated = deprecated
        self.minVersions = minVersions
        self.limit = max(1, min(limit, 100))
    }
}

public import AppleDocsCore

/// Single public projection chokepoint for responses leaving CLI `--json`, MCP, and Web `/api/*`.
///
/// Internal infrastructure fields (SQLite row IDs, cascade tier labels, filesystem paths,
/// pool stats) are excluded by construction: only fields modeled on public projection types
/// can ever serialize across the process boundary.
public struct PublicDocumentSummary: Hashable, Sendable, Codable {
    public let path: String
    public let title: String
    public let rootSlug: String
    public let sourceType: SourceKind
    public let isDeprecated: Bool?
    public let isBeta: Bool?

    public init(
        key: DocumentKey,
        title: String,
        sourceType: SourceKind,
        isDeprecated: Bool = false,
        isBeta: Bool = false
    ) {
        self.path = key.rawValue
        self.title = title
        self.rootSlug = key.rootSlug
        self.sourceType = sourceType
        self.isDeprecated = isDeprecated ? true : nil
        self.isBeta = isBeta ? true : nil
    }
}

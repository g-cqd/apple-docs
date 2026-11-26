public import AppleDocsCore

/// Public summary of a documentation root (framework, HIG, WWDC, Swift book, …).
public struct PublicFrameworkSummary: Hashable, Sendable, Codable {
    public let slug: String
    public let displayName: String
    public let kind: String
    public let sourceType: SourceKind
    public let pageCount: Int

    public init(from root: CorpusRootRecord) {
        self.slug = root.slug
        self.displayName = root.displayName
        self.kind = root.kind
        self.sourceType = root.sourceType
        self.pageCount = root.pageCount
    }
}

/// Metadata describing a top-level documentation root (framework, HIG, WWDC, Swift book, …).
public struct CorpusRootRecord: Hashable, Sendable, Codable {
    public let slug: String
    public let displayName: String
    public let kind: String
    public let sourceType: SourceKind
    public let seedPath: String?
    public let pageCount: Int
    public let status: String
    public let indexETag: String?

    public init(
        slug: String,
        displayName: String,
        kind: String = "framework",
        sourceType: SourceKind = .appleDocC,
        seedPath: String? = nil,
        pageCount: Int = 0,
        status: String = "active",
        indexETag: String? = nil
    ) {
        self.slug = slug
        self.displayName = displayName
        self.kind = kind
        self.sourceType = sourceType
        self.seedPath = seedPath
        self.pageCount = pageCount
        self.status = status
        self.indexETag = indexETag
    }
}

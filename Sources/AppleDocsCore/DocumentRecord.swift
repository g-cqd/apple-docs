/// Normalized metadata for a single documentation record stored in the corpus.
public struct DocumentRecord: Hashable, Sendable, Codable {
    public let key: DocumentKey
    public let sourceType: SourceKind
    public let title: String
    public let kind: String?
    public let role: String?
    public let roleHeading: String?
    public let framework: String
    public let url: String?
    public let language: String?
    public let usr: String?
    public let abstractText: String?
    public let declarationText: String?
    public let headings: String?
    public let availability: PlatformAvailability
    /// Every introduced platform (`{"ios":"16.0","ipados":"16.0",…}` in source order), as Bun stores it.
    public let platformsJSON: String?
    public let isDeprecated: Bool
    public let isBeta: Bool
    public let isReleaseNotes: Bool
    public let urlDepth: Int
    public let sourceMetadataJSON: String?
    public let contentHash: String?

    public init(
        key: DocumentKey,
        sourceType: SourceKind = .appleDocC,
        title: String,
        kind: String? = nil,
        role: String? = nil,
        roleHeading: String? = nil,
        framework: String? = nil,
        url: String? = nil,
        language: String? = nil,
        usr: String? = nil,
        abstractText: String? = nil,
        declarationText: String? = nil,
        headings: String? = nil,
        availability: PlatformAvailability = .none,
        platformsJSON: String? = nil,
        isDeprecated: Bool = false,
        isBeta: Bool = false,
        isReleaseNotes: Bool = false,
        urlDepth: Int = 0,
        sourceMetadataJSON: String? = nil,
        contentHash: String? = nil
    ) {
        self.key = key
        self.sourceType = sourceType
        self.title = title
        self.kind = kind
        self.role = role
        self.roleHeading = roleHeading
        self.framework = framework ?? key.rootSlug
        self.url = url
        self.language = language
        self.usr = usr
        self.abstractText = abstractText
        self.declarationText = declarationText
        self.headings = headings
        self.availability = availability
        self.platformsJSON = platformsJSON
        self.isDeprecated = isDeprecated
        self.isBeta = isBeta
        self.isReleaseNotes = isReleaseNotes
        self.urlDepth = urlDepth
        self.sourceMetadataJSON = sourceMetadataJSON
        self.contentHash = contentHash
    }
}

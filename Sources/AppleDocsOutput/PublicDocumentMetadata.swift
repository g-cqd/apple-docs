public import AppleDocsCore

/// Shared allowlisted metadata header projected across CLI `--json`, MCP, and Web `/api/*`.
///
/// Guarantees that internal row IDs, raw scores, USRs, and filesystem paths cannot leak across
/// any public surface.
public struct PublicDocumentMetadata: Hashable, Sendable, Codable {
    public let path: String
    public let title: String
    public let framework: String
    public let sourceType: SourceKind
    public let kind: String?
    public let roleHeading: String?
    public let language: String?
    public let abstract: String?
    public let declaration: String?
    public let availability: PlatformAvailability?
    public let isDeprecated: Bool?
    public let isBeta: Bool?

    public init(from document: DocumentRecord) {
        self.path = document.key.rawValue
        self.title = document.title
        self.framework = document.framework
        self.sourceType = document.sourceType
        self.kind = document.kind
        self.roleHeading = document.roleHeading
        self.language = document.language
        self.abstract = document.abstractText
        self.declaration = document.declarationText
        self.availability = document.availability == .none ? nil : document.availability
        self.isDeprecated = document.isDeprecated ? true : nil
        self.isBeta = document.isBeta ? true : nil
    }
}

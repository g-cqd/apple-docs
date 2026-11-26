public import AppleDocsCore

/// Public relationship edge projected across CLI `links --json` and Web/MCP link queries.
public struct PublicDocumentLink: Hashable, Sendable, Codable {
    public let from: String
    public let to: String
    public let relationType: String
    public let section: String?

    public init(from record: DocumentRelationshipRecord) {
        self.from = record.fromKey.rawValue
        self.to = record.toKey.rawValue
        self.relationType = record.relationType
        self.section = record.section
    }
}

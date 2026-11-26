/// Directed relationship edge between two corpus document keys.
public struct DocumentRelationshipRecord: Hashable, Sendable, Codable {
    public let fromKey: DocumentKey
    public let toKey: DocumentKey
    public let relationType: String
    public let section: String?
    public let sortOrder: Int

    public init(
        fromKey: DocumentKey,
        toKey: DocumentKey,
        relationType: String = "reference",
        section: String? = nil,
        sortOrder: Int = 0
    ) {
        self.fromKey = fromKey
        self.toKey = toKey
        self.relationType = relationType
        self.section = section
        self.sortOrder = sortOrder
    }
}

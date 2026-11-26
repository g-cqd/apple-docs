/// Single ordered content section belonging to a ``DocumentRecord``.
public struct DocumentSectionRecord: Hashable, Sendable, Codable {
    public let sectionKind: String
    public let heading: String?
    public let contentText: String
    public let contentJSON: String?
    public let sortOrder: Int

    public init(
        sectionKind: String,
        heading: String? = nil,
        contentText: String,
        contentJSON: String? = nil,
        sortOrder: Int = 0
    ) {
        self.sectionKind = sectionKind
        self.heading = heading
        self.contentText = contentText
        self.contentJSON = contentJSON
        self.sortOrder = sortOrder
    }
}

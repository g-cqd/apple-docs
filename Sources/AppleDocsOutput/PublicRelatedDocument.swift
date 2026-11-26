/// An outgoing relationship target with its display title, for linked topic / see-also / relationship navigation.
public struct PublicRelatedDocument: Hashable, Sendable, Codable {
    public let path: String
    public let title: String
    public let relationType: String
    public let section: String?
    /// Whether the target page exists in the corpus (only available targets are linked).
    public let isAvailable: Bool

    public init(path: String, title: String, relationType: String, section: String?, isAvailable: Bool = true) {
        self.path = path
        self.title = title
        self.relationType = relationType
        self.section = section
        self.isAvailable = isAvailable
    }

    /// Group label: the source section heading when present, else a humanized relation type.
    public var groupTitle: String {
        if let section, !section.isEmpty { return section }
        return relationType.replacing("_", with: " ").split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

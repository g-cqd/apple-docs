/// Bounded text excerpt window around a substring match within a documentation page.
public struct PublicMatchExcerpt: Hashable, Sendable, Codable {
    public let sectionHeading: String?
    public let offset: Int
    public let excerpt: String

    public init(sectionHeading: String?, offset: Int, excerpt: String) {
        self.sectionHeading = sectionHeading
        self.offset = offset
        self.excerpt = excerpt
    }
}

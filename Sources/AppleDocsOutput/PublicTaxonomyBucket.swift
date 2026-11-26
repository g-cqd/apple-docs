/// Public taxonomy bucket pairing a distinct field value with its document count.
public struct PublicTaxonomyBucket: Hashable, Sendable, Codable {
    public let value: String
    public let count: Int

    public init(value: String, count: Int) {
        self.value = value
        self.count = count
    }
}

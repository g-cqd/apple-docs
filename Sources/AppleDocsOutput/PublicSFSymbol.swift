/// Public SF Symbol metadata projected across CLI `--json`, MCP `search_sf_symbols`, and Web `/api/symbols`.
public struct PublicSFSymbol: Hashable, Sendable, Codable {
    public let name: String
    public let scope: String
    public let categories: [String]
    public let keywords: [String]
    public let aliases: [String]
    public let codepoint: Int?
    public let bitmapOnly: Bool?

    public init(
        name: String,
        scope: String,
        categories: [String] = [],
        keywords: [String] = [],
        aliases: [String] = [],
        codepoint: Int? = nil,
        bitmapOnly: Bool = false
    ) {
        self.name = name
        self.scope = scope
        self.categories = categories
        self.keywords = keywords
        self.aliases = aliases
        self.codepoint = codepoint
        self.bitmapOnly = bitmapOnly ? true : nil
    }
}

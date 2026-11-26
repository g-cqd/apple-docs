/// Arguments of a search (Bun `search(opts)`).
public struct SearchOptions: Sendable {
    public var query: String
    public var framework: String?
    /// Comma-separated source slugs.
    public var source: String?
    public var kind: String?
    public var language: String?
    public var platform: String?
    /// Minimum versions keyed by platform (`ios`, `macos`, `watchos`, `tvos`, `visionos`).
    public var minimumVersions: [String: String]
    public var limit: Int
    public var offset: Int
    public var year: Int?
    public var track: String?
    public var deprecated: String?
    public var fuzzy: Bool
    public var noDeep: Bool
    public var noEager: Bool
    public var fast: Bool

    // @dl:disable -- defaulted parameter list (shape shared with DocumentRecord)
    public init(
        query: String,
        framework: String? = nil,
        source: String? = nil,
        kind: String? = nil,
        language: String? = nil,
        platform: String? = nil,
        minimumVersions: [String: String] = [:],
        limit: Int = 25,
        offset: Int = 0,
        year: Int? = nil,
        track: String? = nil,
        deprecated: String? = nil
    ) {
        self.query = query
        self.framework = framework
        self.source = source
        self.kind = kind
        self.language = language
        self.platform = platform
        self.minimumVersions = minimumVersions
        self.limit = max(limit, 1)
        self.offset = max(offset, 0)
        self.year = year
        self.track = track
        self.deprecated = deprecated
        self.fuzzy = true
        self.noDeep = false
        self.noEager = false
        self.fast = false
        // @dl:enable
    }
}

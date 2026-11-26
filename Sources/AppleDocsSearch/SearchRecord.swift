import AppleDocsStorage

/// One candidate document row as Bun's search repository returns it (`RESULT_COLUMNS` in `search-sql.js`).
public struct SearchRecord: Sendable, Equatable {
    public var id: Int64?
    public var path: String
    public var title: String?
    public var role: String?
    public var roleHeading: String?
    public var abstract: String?
    public var declaration: String?
    /// Raw `platforms_json` text.
    public var platforms: String?
    public var minIOS: String?
    public var minMacOS: String?
    public var minWatchOS: String?
    public var minTvOS: String?
    public var minVisionOS: String?
    /// Root display name (`COALESCE(r.display_name, d.framework)`).
    public var framework: String?
    public var rootSlug: String?
    public var sourceType: String?
    public var sourceMetadata: String?
    public var urlDepth: Int64?
    public var isReleaseNotes: Bool
    public var isDeprecated: Bool
    public var isBeta: Bool
    public var docKind: String?
    public var language: String?
    /// FTS title tier (`0` exact … `3` match), when the query computed one.
    public var tier: Int?

    /// The `SELECT` list (`d` = documents, `r` = roots) decoded by ``init(row:offset:)``.
    static let columns = """
        d.key, d.title, d.role, d.role_heading, d.abstract_text, d.declaration_text, d.platforms_json,
        d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
        COALESCE(r.display_name, d.framework), COALESCE(r.slug, d.framework),
        d.source_type, d.source_metadata, d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta,
        d.kind, d.language
        """
    static let columnCount = 22

    /// Decodes ``columns`` starting at `offset`.
    init(row: SQLiteRow, offset: Int = 0, id: Int64? = nil, tier: Int? = nil) throws(SQLiteError) {
        func text(_ index: Int) throws(SQLiteError) -> String? { try row.optionalText(at: offset + index) }
        func flag(_ index: Int) throws(SQLiteError) -> Bool { (try row.optionalInteger(at: offset + index) ?? 0) != 0 }
        // @dl:disable -- column-by-column decode of RESULT_COLUMNS
        self.id = id
        self.path = try row.text(at: offset)
        self.title = try text(1)
        self.role = try text(2)
        self.roleHeading = try text(3)
        self.abstract = try text(4)
        self.declaration = try text(5)
        self.platforms = try text(6)
        self.minIOS = try text(7)
        self.minMacOS = try text(8)
        self.minWatchOS = try text(9)
        self.minTvOS = try text(10)
        self.minVisionOS = try text(11)
        self.framework = try text(12)
        self.rootSlug = try text(13)
        self.sourceType = try text(14)
        self.sourceMetadata = try text(15)
        self.urlDepth = try row.optionalInteger(at: offset + 16)
        self.isReleaseNotes = try flag(17)
        self.isDeprecated = try flag(18)
        self.isBeta = try flag(19)
        self.docKind = try text(20)
        self.language = try text(21)
        self.tier = tier
        // @dl:enable
    }
}

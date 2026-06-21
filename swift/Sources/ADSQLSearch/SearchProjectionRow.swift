public import ADDBExec
public import ADSQLModel

/// One decoded §2.3 search-projection row — the structured counterpart to ``Database/searchPagesFramedDenorm(_:)``
/// (which returns the §2.5 *bytes*). The cascade's lexical tier consumes structured rows (the apple-docs
/// `SearchRow`), not the framed payload, so this is the building block for serving `Cascade.search` off the
/// native engine: run the denorm query, decode each ``SQLRow`` by the projection's column aliases via
/// ``RowDecoder``, return rows. The field set + order mirrors the apple-docs `SearchRow`; consolidating the
/// two onto one shared type (so the SQLite + ADDB paths share it) is the cascade-wiring step (the SQLite
/// `SearchRow` lives in the storage target, which the ADDB path must not import).
public struct SearchProjectionRow: Sendable, Equatable {
    public var path: String
    public var title: String?
    public var role: String?
    public var roleHeading: String?
    public var abstract: String?
    public var declaration: String?
    public var platforms: String?
    public var minIOS: String?
    public var minMacOS: String?
    public var minWatchOS: String?
    public var minTVOS: String?
    public var minVisionOS: String?
    public var framework: String?
    public var rootSlug: String?
    public var sourceType: String?
    public var sourceMetadata: String?
    public var urlDepth: Int64?
    public var isReleaseNotes: Int64?
    public var isDeprecated: Int64?
    public var isBeta: Int64?
    public var docKind: String?
    public var language: String?
    public var rank: Double?
    public var tier: Int64?

    /// Decode one projection row by the §2.3 column aliases (`d.key AS path`, `root_display AS framework`,
    /// `bm25(…) AS rank`, the tier `CASE AS tier`, …) — by NAME, so a projection reorder can't mis-map.
    public init(_ d: RowDecoder) {
        path = d.text("path") ?? ""
        title = d.text("title")
        role = d.text("role")
        roleHeading = d.text("role_heading")
        abstract = d.text("abstract")
        declaration = d.text("declaration")
        platforms = d.text("platforms")
        minIOS = d.text("min_ios")
        minMacOS = d.text("min_macos")
        minWatchOS = d.text("min_watchos")
        minTVOS = d.text("min_tvos")
        minVisionOS = d.text("min_visionos")
        framework = d.text("framework")
        rootSlug = d.text("root_slug")
        sourceType = d.text("source_type")
        sourceMetadata = d.text("source_metadata")
        urlDepth = d.int("url_depth")
        isReleaseNotes = d.int("is_release_notes")
        isDeprecated = d.int("is_deprecated")
        isBeta = d.int("is_beta")
        docKind = d.text("doc_kind")
        language = d.text("language")
        rank = d.double("rank")
        tier = d.int("tier")
    }
}

extension Database {
    /// Runs the DENORMALIZED §2.2 search query for `params` and returns the decoded §2.3 projection rows
    /// (via ``RowDecoder``) — the structured form the cascade consumes, the ADDB-native counterpart to the
    /// SQLite `StorageConnection.ftsRows`. Same query + bindings as ``searchPagesFramedDenorm(_:)``, so the
    /// rows correspond exactly to that proven framed output (`SearchProjectionRowsTests` checks both agree).
    /// Requires the serving setup (``prepareForDenormServing()``): FTS + JSON registered, denorm populated.
    public func searchPagesDenormRows(_ params: SearchPagesParams) throws(DBError) -> [SearchProjectionRow] {
        try prepare(SearchQuery.denormSQL)
            .all(SearchQuery.denormBindings(for: params))
            .map { SearchProjectionRow($0.decode()) }
    }
}

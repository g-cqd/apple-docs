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
    /// The score-all DENORMALIZED §2.2 read: runs ``SearchQuery/denormSQL`` verbatim
    /// (`… ORDER BY tier, rank LIMIT $limit`), scoring EVERY match to sort by
    /// `(tier, rank)`. This is the correctness oracle the restructured
    /// ``searchPagesDenormRows(_:)`` (WS-C: rank-only WAND + tier reorder) is proven
    /// identical to; it stays reachable for the parity diff (`SearchWANDRankParityTests`)
    /// and is the fallback path for the shapes the WAND restructure declines
    /// (active §2.4 filters, LIKE-metacharacter raw terms, pathological tier tails).
    public func searchPagesDenormRowsScoreAll(_ params: SearchPagesParams) throws(DBError) -> [SearchProjectionRow] {
        try prepare(SearchQuery.denormSQL)
            .all(SearchQuery.denormBindings(for: params))
            .map { SearchProjectionRow($0.decode()) }
    }
}

/// The decoded `ad_storage_search_pages` request (/ apple-docs'
/// `SearchPagesParams`): the FTS query, the verbatim `raw` term that drives the
/// tier `CASE`, the result `limit`, and the 13 filter predicates of §2.4 — each
/// optional, where a `nil` value is a passthrough (the filter does not bite).
///
/// This is the Swift mirror of the wire request bag. The C `@_cdecl` shim that
/// apple-docs owns (`ad_storage_search_pages`) decodes the §2.5 request bytes
/// into one of these and hands it to ``searchPagesFramed(_:_:)``; that decode +
/// export lands in a LATER step and is NOT part of this prototype.
public struct SearchPagesParams: Sendable {
    /// The FTS5 `MATCH` query string (drives `documents_fts MATCH $query`).
    public var query: String
    /// The verbatim user term the tier `CASE` compares against (`$raw`).
    public var raw: String
    /// The top-k bound (`ORDER BY tier, rank LIMIT $limit`).
    public var limit: Int64

    // MARK: - §2.4 filter bag (each nil ⇒ the predicate passes through)

    /// `framework` (=) — bound to a roots slug (`d.framework = $framework`).
    public var framework: String?
    /// `source_type` (=) — `d.source_type = $source_type`.
    public var sourceType: String?
    /// `sources_json` — `d.source_type IN (SELECT value FROM json_each($sources_json))`.
    public var sourcesJSON: String?
    /// `kind` — LOWER-match over `role_heading` / `kind` / `role`.
    public var kind: String?
    /// `language` — `=` / NULL / the literal `'both'` passthrough.
    public var language: String?
    /// `year` — `CAST(json_extract(source_metadata,'$.year') AS INTEGER) = $year`.
    public var year: Int64?
    /// `track_like` — `LOWER(COALESCE(json_extract(source_metadata,'$.track'),'')) LIKE $track_like`.
    public var trackLike: String?
    /// `deprecated_mode` — `include` (default, no filter) / `exclude` (only
    /// non-deprecated) / `only` (only deprecated). Lowered to the two NULL-guarded
    /// `is_deprecated` predicates apple-docs binds. Defaults to `"include"`.
    public var deprecatedMode: String?
    /// `min_ios` — `min_ios_num IS NULL OR min_ios_num <= $min_ios`.
    public var minIOS: Int64?
    /// `min_macos` — `min_macos_num IS NULL OR min_macos_num <= $min_macos`.
    public var minMacOS: Int64?
    /// `min_watchos` — `min_watchos_num IS NULL OR min_watchos_num <= $min_watchos`.
    public var minWatchOS: Int64?
    /// `min_tvos` — `min_tvos_num IS NULL OR min_tvos_num <= $min_tvos`.
    public var minTVOS: Int64?
    /// `min_visionos` — `min_visionos_num IS NULL OR min_visionos_num <= $min_visionos`.
    public var minVisionOS: Int64?

    public init(
        query: String,
        raw: String,
        limit: Int64,
        framework: String? = nil,
        sourceType: String? = nil,
        sourcesJSON: String? = nil,
        kind: String? = nil,
        language: String? = nil,
        year: Int64? = nil,
        trackLike: String? = nil,
        deprecatedMode: String? = "include",
        minIOS: Int64? = nil,
        minMacOS: Int64? = nil,
        minWatchOS: Int64? = nil,
        minTVOS: Int64? = nil,
        minVisionOS: Int64? = nil
    ) {
        self.query = query
        self.raw = raw
        self.limit = limit
        self.framework = framework
        self.sourceType = sourceType
        self.sourcesJSON = sourcesJSON
        self.kind = kind
        self.language = language
        self.year = year
        self.trackLike = trackLike
        self.deprecatedMode = deprecatedMode
        self.minIOS = minIOS
        self.minMacOS = minMacOS
        self.minWatchOS = minWatchOS
        self.minTVOS = minTVOS
        self.minVisionOS = minVisionOS
    }
}

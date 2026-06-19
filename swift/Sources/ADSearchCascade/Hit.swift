// The formatted search hit. The cascade merges SearchRows into ResultHits
// (assigning matchQuality), rerank scores them, projection emits them.
// Only the fields rerank + the projection allowlist need are kept.

import ADStorage

/// The public, read-only view of a sliced search hit. The CLI human formatter
/// reads the RAW `matchQuality` + `distance` (the fuzzy badge), not the projected
/// `confidence`; the search `--json` path reuses the cascade's projected envelope
/// instead. The remaining fields (rootSlug/declaration/platforms/language/
/// isReleaseNotes) let the CLI `--read --json` path re-project the single top hit
/// as `projectSearchResult({results:[hit]}).results[0]`. `relatedCount` is nil
/// when enrichment was unavailable (the formatter treats nil as 0, matching JS
/// `r.relatedCount > 0`).
public struct SearchHitView: Sendable {
    public let path: String
    public let title: String?
    public let framework: String?
    public let rootSlug: String?
    public let kind: String?
    public let sourceType: String?
    public let abstract: String?
    public let declaration: String?
    public let platforms: String?  // raw platforms_json (verbatim — JSON round-trip is identity)
    public let language: String?
    public let snippet: String?
    public let relatedCount: Int?
    public let matchQuality: String
    public let distance: Int?
    public let isReleaseNotes: Bool
    public let isDeprecated: Bool
    public let isBeta: Bool

    /// The public `confidence` (projectSearchHit): exact/approximate/partial.
    public var confidence: String {
        if matchQuality == "exact" { return "exact" }
        if matchQuality == "fuzzy" { return "approximate" }
        if matchQuality.hasPrefix("relaxed") { return "approximate" }
        return "partial"
    }
}

/// The full result of a CLI search: the structured hits (for the human
/// formatter), the envelope counts (`total`/`hasMore`), the echoed query, and the
/// projected JSON envelope bytes (`--json` reuses these verbatim — they equal
/// `projectSearchResult`).
public struct SearchOutcome: Sendable {
    public let hits: [SearchHitView]
    public let total: Int
    public let hasMore: Bool
    public let query: String
    public let envelope: [UInt8]
}

struct ResultHit {
    var path: String
    var title: String?
    var framework: String?
    var rootSlug: String?
    var sourceType: String?
    var kind: String?  // role_heading ?? role
    var abstract: String?
    var declaration: String?
    var platforms: String?  // raw platforms_json — emitted verbatim (JSON round-trip is identity)
    var language: String?
    var urlDepth: Int64
    var isReleaseNotes: Bool
    var isDeprecated: Bool
    var isBeta: Bool
    var matchQuality: String

    var score: Double = 0
    var origIndex: Int = 0  // insertion order, for a stable total-order sort

    // Levenshtein distance — set only on the fuzzy tier (JS `formatResult(rec,
    // 'fuzzy', fm.distance)`). The human CLI formatter reads it for the
    // ` [fuzzy d=<n>]` badge; the projection never emits it.
    var distance: Int?

    // Enrichment — nil = not enriched (omitted from the projection when
    // getRelatedDocCounts is unavailable).
    var snippet: String?
    var relatedCount: Int?

    /// A public projection of the sliced hit for the CLI.
    var publicHit: SearchHitView {
        SearchHitView(
            path: path, title: title, framework: framework, rootSlug: rootSlug, kind: kind,
            sourceType: sourceType, abstract: abstract, declaration: declaration, platforms: platforms,
            language: language, snippet: snippet, relatedCount: relatedCount, matchQuality: matchQuality,
            distance: distance, isReleaseNotes: isReleaseNotes, isDeprecated: isDeprecated, isBeta: isBeta)
    }

    /// formatResult(row, matchQuality).
    init(_ row: SearchRow, matchQuality: String) {
        path = row.path
        title = row.title
        framework = row.framework
        rootSlug = row.rootSlug
        sourceType = row.sourceType
        kind = row.roleHeading ?? row.role
        abstract = row.abstract
        declaration = row.declaration
        platforms = row.platforms
        language = row.language
        urlDepth = row.urlDepth ?? 0
        isReleaseNotes = (row.isReleaseNotes ?? 0) != 0
        isDeprecated = (row.isDeprecated ?? 0) != 0
        isBeta = (row.isBeta ?? 0) != 0
        self.matchQuality = matchQuality
    }
}

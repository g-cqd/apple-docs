// A decoded search-cascade row. The lexical tiers produce [SearchRow], the
// cascade (ADSearch) merges/reranks/projects them. Columns are decoded
// POSITIONALLY in the pinned resultColumns order; the parity test catches
// any SQL drift.

public struct SearchRow: Sendable {
    public var path: String
    public var title: String?
    public var role: String?
    public var roleHeading: String?
    public var abstract: String?
    public var declaration: String?
    public var platforms: String?  // raw platforms_json (emitted verbatim — JSON round-trip is identity)
    public var minIos: String?
    public var minMacos: String?
    public var minWatchos: String?
    public var minTvos: String?
    public var minVisionos: String?
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

    // Assigned by the cascade (not from the row).
    public var matchQuality: String = "match"
    public var score: Double = 0

    init(path: String) { self.path = path }

    static func decode(_ s: PreparedStatement, hasRankTier: Bool) -> SearchRow {
        var r = SearchRow(path: s.text(0) ?? "")
        r.title = s.text(1)
        r.role = s.text(2)
        r.roleHeading = s.text(3)
        r.abstract = s.text(4)
        r.declaration = s.text(5)
        r.platforms = s.text(6)
        r.minIos = s.text(7)
        r.minMacos = s.text(8)
        r.minWatchos = s.text(9)
        r.minTvos = s.text(10)
        r.minVisionos = s.text(11)
        r.framework = s.text(12)
        r.rootSlug = s.text(13)
        r.sourceType = s.text(14)
        r.sourceMetadata = s.text(15)
        r.urlDepth = s.int(16)
        r.isReleaseNotes = s.int(17)
        r.isDeprecated = s.int(18)
        r.isBeta = s.int(19)
        r.docKind = s.text(20)
        r.language = s.text(21)
        if hasRankTier {
            r.rank = s.double(22)
            r.tier = s.int(23)
        }
        return r
    }
}

// MARK: - Tier queries (in-process; the cascade calls these on one connection)

extension StorageConnection {
    /// T1 FTS5 planner (bm25 + tier CASE). nil on a prepare/step error.
    public func ftsRows(_ params: SearchPagesParams) -> [SearchRow]? {
        rows(sql: searchPagesSQL, params: params, hasRankTier: true)
    }

    /// T1 title-exact (COLLATE NOCASE), rows tagged tier 0.
    public func titleExactRows(_ params: SearchPagesParams) -> [SearchRow]? {
        rows(sql: searchTitleExactSQL, params: params, hasRankTier: true)
    }

    /// T2 trigram; [] when documents_trigram is absent (lite snapshots).
    public func trigramRows(_ params: SearchPagesParams) -> [SearchRow]? {
        guard conn.hasTrigram else { return [] }
        return rows(sql: searchTrigramSQL, params: params, hasRankTier: false)
    }

    /// T4 body FTS; [] when documents_body_fts is absent or empty. The SQL adds a
    /// bm25 rank for ORDER BY only — the decoder ignores it (hasRankTier: false).
    public func bodyRows(_ params: SearchPagesParams) -> [SearchRow]? {
        guard conn.hasBodyFts else { return [] }
        return rows(sql: searchBodySQL, params: params, hasRankTier: false)
    }

    private func rows(sql: String, params: SearchPagesParams, hasRankTier: Bool) -> [SearchRow]? {
        guard let stmt = conn.statement(sql) else { return nil }
        bindSearchPages(stmt, params)
        defer { stmt.reset() }
        var out: [SearchRow] = []
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { return nil }
            out.append(SearchRow.decode(stmt, hasRankTier: hasRankTier))
        }
        return out
    }
}

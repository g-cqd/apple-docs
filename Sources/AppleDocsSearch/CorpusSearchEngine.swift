import AppleDocsCore
public import AppleDocsStorage

/// Multi-tier lexical + trigram search engine over a Swift v1 ``SQLiteConnection``.
///
/// Retrieval cascade (stopping early once exact identifier queries or `limit` saturate):
/// 1. Exact title / key / USR match (`confidence = .exact`)
/// 2. FTS5 BM25 on `documents_fts` (`confidence = .partial`)
/// 3. FTS5 trigram substring fallback on `documents_trigram` (`confidence = .approximate`)
/// 4. FTS5 body fallback on `documents_body_fts` (`confidence = .approximate`)
public enum CorpusSearchEngine: Sendable {
    /// Executes the filtered search cascade against `connection`.
    public static func search(
        _ request: CorpusSearchRequest,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [CorpusSearchHit] {
        let trimmed = FTSQueryBuilder.trimWhitespace(request.query)
        guard !trimmed.isEmpty else { return [] }

        let filter = buildFilterClause(request)
        var seen: Set<Int64> = []
        var results: [CorpusSearchHit] = []
        results.reserveCapacity(request.limit)

        let exactHits = try queryExact(trimmed, filter: filter, limit: request.limit, on: connection)
        appendTier(exactHits, into: &results, seen: &seen, limit: request.limit)
        if !exactHits.isEmpty, isUniqueIdentifierQuery(trimmed) { return results }
        if results.count >= request.limit { return results }

        let ftsExpr = FTSQueryBuilder.buildLexicalQuery(trimmed)
        for tier in virtualTiers(trimmed: trimmed, ftsExpr: ftsExpr, limit: request.limit) {
            let hits = try queryVirtualTier(tier, filter: filter, on: connection)
            appendTier(hits, into: &results, seen: &seen, limit: request.limit)
            if results.count >= request.limit { break }
        }
        return results
    }

    private static func virtualTiers(trimmed: String, ftsExpr: String, limit: Int) -> [VirtualTierSpec] {
        var tiers: [VirtualTierSpec] = []
        if ftsExpr != "\"\"" {
            tiers.append(
                VirtualTierSpec(
                    table: "documents_fts",
                    scoreExpression: "-bm25(documents_fts, 10.0, 4.0, 2.0, 2.0, 3.0)",
                    tieBreaker: "d.url_depth ASC",
                    matchExpr: ftsExpr,
                    limit: limit * 3,
                    confidence: .partial
                )
            )
        }
        if trimmed.utf8.count >= 3 {
            tiers.append(
                VirtualTierSpec(
                    table: "documents_trigram",
                    scoreExpression: "-bm25(documents_trigram)",
                    tieBreaker: "length(d.title) ASC",
                    matchExpr: FTSQueryBuilder.sanitizeTrigramQuery(trimmed),
                    limit: limit * 2,
                    confidence: .approximate
                )
            )
        }
        if ftsExpr != "\"\"" {
            tiers.append(
                VirtualTierSpec(
                    table: "documents_body_fts",
                    scoreExpression: "-bm25(documents_body_fts)",
                    tieBreaker: "d.url_depth ASC",
                    matchExpr: ftsExpr,
                    limit: limit * 2,
                    confidence: .approximate
                )
            )
        }
        return tiers
    }

    private static func isUniqueIdentifierQuery(_ query: String) -> Bool {
        query.hasPrefix("s:") || query.hasPrefix("c:") || query.contains("/")
    }

    private static func appendTier(
        _ hits: [CorpusSearchHit],
        into results: inout [CorpusSearchHit],
        seen: inout Set<Int64>,
        limit: Int
    ) {
        for hit in hits where results.count < limit {
            if seen.insert(hit.documentID).inserted {
                results.append(hit)
            }
        }
    }

    private static func queryExact(
        _ query: String,
        filter: FilterClause,
        limit: Int,
        on db: SQLiteConnection
    ) throws(SQLiteError) -> [CorpusSearchHit] {
        let lower = query.lowercased()
        let sql = """
            SELECT d.id, \(CorpusStore.documentColumnList), 100.0 AS rank_score
            FROM documents d
            WHERE (d.title = ? COLLATE NOCASE OR d.key = ? OR d.usr = ?)
            \(filter.sql)
            ORDER BY CASE WHEN d.key = ? THEN 0 WHEN d.title = ? COLLATE NOCASE THEN 1 ELSE 2 END,
                     d.url_depth ASC, d.title ASC
            LIMIT ?
            """
        let bindings: [SQLiteValue] =
            [.text(query), .text(lower), .text(query)]
            + filter.bindings
            + [.text(lower), .text(query), .integer(Int64(limit))]
        return try db.query(sql, bindings: bindings)
            .map { row throws(SQLiteError) in
                try decodeHit(row, confidence: .exact)
            }
    }

    private static func queryVirtualTier(
        _ tier: VirtualTierSpec,
        filter: FilterClause,
        on db: SQLiteConnection
    ) throws(SQLiteError) -> [CorpusSearchHit] {
        let sql = """
            SELECT d.id, \(CorpusStore.documentColumnList), \(tier.scoreExpression) AS rank_score
            FROM \(tier.table)
            JOIN documents d ON d.id = \(tier.table).rowid
            WHERE \(tier.table) MATCH ?
            \(filter.sql)
            ORDER BY rank_score DESC, \(tier.tieBreaker)
            LIMIT ?
            """
        let bindings = [.text(tier.matchExpr)] + filter.bindings + [.integer(Int64(tier.limit))]
        return try db.query(sql, bindings: bindings)
            .map { row throws(SQLiteError) in
                try decodeHit(row, confidence: tier.confidence)
            }
    }

    private static func buildFilterClause(_ request: CorpusSearchRequest) -> FilterClause {
        var clauses: [String] = []
        var bindings: [SQLiteValue] = []

        if let framework = request.framework?.lowercased() {
            clauses.append("AND d.framework = ?")
            bindings.append(.text(framework))
        }
        if let kind = request.kind?.lowercased() {
            clauses.append(
                "AND (LOWER(COALESCE(d.role_heading,'')) = ? OR LOWER(COALESCE(d.kind,'')) = ? OR LOWER(COALESCE(d.role,'')) = ?)"
            )
            bindings.append(contentsOf: [.text(kind), .text(kind), .text(kind)])
        }
        if let language = request.language?.lowercased() {
            clauses.append("AND (d.language IS NULL OR d.language = ? OR d.language = 'both')")
            bindings.append(.text(language))
        }
        if !request.sources.isEmpty {
            let placeholders = Array(repeating: "?", count: request.sources.count).joined(separator: ", ")
            clauses.append("AND d.source_type IN (\(placeholders))")
            bindings.append(contentsOf: request.sources.map { .text($0.rawValue) })
        }
        switch request.deprecated {
            case .include: break
            case .exclude: clauses.append("AND d.is_deprecated = 0")
            case .only: clauses.append("AND d.is_deprecated = 1")
        }
        let platforms: [(String, Int64?)] = [
            ("min_ios_num", request.minVersions.iosNumeric),
            ("min_macos_num", request.minVersions.macosNumeric),
            ("min_watchos_num", request.minVersions.watchosNumeric),
            ("min_tvos_num", request.minVersions.tvosNumeric),
            ("min_visionos_num", request.minVersions.visionosNumeric)
        ]
        for (column, limitNum) in platforms {
            if let limitNum {
                clauses.append("AND (d.\(column) IS NULL OR d.\(column) <= ?)")
                bindings.append(.integer(limitNum))
            }
        }
        return FilterClause(sql: clauses.joined(separator: "\n"), bindings: bindings)
    }

    private static func decodeHit(_ row: SQLiteRow, confidence: SearchConfidence) throws(SQLiteError) -> CorpusSearchHit
    {
        let documentID = try row.integer(at: 0)
        let document = try CorpusStore.decodeDocument(row, offset: 1)
        let scoreCell = try row.value(at: 25)
        let score = scoreCell.realValue ?? Double(scoreCell.integerValue ?? 0)
        return CorpusSearchHit(
            documentID: documentID,
            document: document,
            score: score,
            confidence: confidence
        )
    }
}

private struct FilterClause {
    let sql: String
    let bindings: [SQLiteValue]
}

private struct VirtualTierSpec {
    let table: String
    let scoreExpression: String
    let tieBreaker: String
    let matchExpr: String
    let limit: Int
    let confidence: SearchConfidence
}

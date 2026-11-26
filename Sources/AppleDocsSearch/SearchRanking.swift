/// Bun's result reranking (`search/ranking.js` `rerank`).
enum SearchRanking {
    // @dl:disable -- Bun's ranking tables (declarative score maps)
    static let baseScores: [String: Double] = [
        "exact": 100, "prefix": 80, "contains": 60, "match": 50, "substring": 30, "fuzzy": 20, "body": 10,
        "relaxed": 9, "relaxed-or": 7, "relaxed-token": 5
    ]
    static let qualityOrder: [String: Double] = [
        "exact": 0, "prefix": 1, "contains": 2, "match": 3, "substring": 4, "fuzzy": 5, "body": 6, "relaxed": 7,
        "relaxed-or": 8, "relaxed-token": 9
    ]
    private static let symbolKinds: Set<String> = [
        "symbol", "class", "cl", "structure", "struct", "structp", "protocol", "enum", "enumeration", "econst", "case",
        "union", "property wrapper", "property", "instp", "var", "type alias", "typealias", "tdef", "function", "func",
        "method", "instm", "clm", "init", "op", "macro"
    ]
    private static let sourceMultipliers: [String: Double] = [
        "apple-docc": 1.3, "hig": 1.2, "sample-code": 1.12, "guidelines": 1.05
    ]
    private static let sourceOrder: [String: Double] = ["apple-docc": 0, "hig": 1, "sample-code": 2, "guidelines": 3]
    // @dl:enable

    static func rerank(_ results: [SearchResultItem], query: String, intent: SearchIntent) -> [SearchResultItem] {
        let scored = results.map { item in
            var copy = item
            copy.score = score(item, query: query, intent: intent)
            return copy
        }
        return JSArraySort.sorted(scored) { lhs, rhs in
            let difference = (rhs.score ?? 0) - (lhs.score ?? 0)
            if abs(difference) > 0.001 { return difference }
            let quality = (qualityOrder[lhs.matchQuality] ?? 9) - (qualityOrder[rhs.matchQuality] ?? 9)
            if quality != 0 { return quality }
            return (sourceOrder[(lhs.record.sourceType ?? "").lowercased()] ?? 99)
                - (sourceOrder[(rhs.record.sourceType ?? "").lowercased()] ?? 99)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    private static func score(_ item: SearchResultItem, query: String, intent: SearchIntent) -> Double {
        let record = item.record
        let lowerQuery = query.lowercased()
        let sourceType = (record.sourceType ?? "").lowercased()
        let kind = (record.roleHeading ?? record.role ?? "").lowercased()  // formatted `kind`; no docKind there
        let title = (record.title ?? "").lowercased()
        var score = baseScores[item.matchQuality] ?? 50
        let lastSegment =
            record.path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        if lastSegment.lowercased() == lowerQuery || title == lowerQuery {
            score *= 3.0
            if record.title == query { score *= 1.1 }
        }
        switch intent.kind {
            case .symbol where symbolKinds.contains(kind): score *= 1.5
            case .howto where sourceType == "hig" || sourceType == "guidelines" || kind == "article": score *= 1.3
            default: break
        }
        if record.isReleaseNotes || record.path.contains("release-notes") { score *= 0.4 }
        if sourceType == "apple-archive" { score *= 0.6 }
        if sourceType == "sample-code",
            intent.kind == .howto || lowerQuery.contains("example") || lowerQuery.contains("sample")
        {
            score *= 1.2
        }
        if sourceType == "packages" {
            score *= 0.45
            if lowerQuery.contains("package") || lowerQuery.contains("library") || title == lowerQuery { score *= 1.5 }
        }
        score *= sourceMultipliers[sourceType] ?? 1.0
        let depth = Double(record.urlDepth ?? 0)
        if depth > 0 { score *= max(0.3, 1.0 - depth * 0.05) }
        switch intent.kind {
            case .error where kind == "article" || title.contains("error") || title.contains("troubleshoot"):
                score *= 1.2
            case .concept where kind == "article" || sourceType == "hig" || sourceType == "swift-book": score *= 1.2
            case .wwdc where sourceType == "wwdc": score *= 1.4
            default: break
        }
        return score
    }
}

// Byte-exact port of the JS ranking module. The score multipliers are IEEE
// doubles applied in the SAME order, so Swift `Double` yields bit-identical
// scores → identical ordering. JS `Array.sort` is stable; Swift's isn't, so
// the comparator carries the original insertion index as a final tie-break,
// making it a deterministic TOTAL order that reproduces JS's stable result.

import Algorithms

enum Rerank {
    private static let baseScores: [String: Double] = [
        "exact": 100, "prefix": 80, "contains": 60, "match": 50, "substring": 30,
        "fuzzy": 20, "body": 10, "relaxed": 9, "relaxed-or": 7, "relaxed-token": 5
    ]
    private static let symbolKinds: Set<String> = [
        "symbol", "class", "cl", "structure", "struct", "structp", "protocol",
        "enum", "enumeration", "econst", "case", "union",
        "property wrapper", "property", "instp", "var",
        "type alias", "typealias", "tdef",
        "function", "func", "method", "instm", "clm", "init", "op", "macro"
    ]
    private static let sourceMultipliers: [String: Double] = [
        "apple-docc": 1.3, "hig": 1.2, "sample-code": 1.12, "guidelines": 1.05
    ]
    private static let sourceOrder: [String: Int] = [
        "apple-docc": 0, "hig": 1, "sample-code": 2, "guidelines": 3
    ]
    private static let qualityOrder: [String: Int] = [
        "exact": 0, "prefix": 1, "contains": 2, "match": 3, "substring": 4,
        "fuzzy": 5, "body": 6, "relaxed": 7, "relaxed-or": 8, "relaxed-token": 9
    ]

    /// Scores `results` in place, then returns the top `window` hits in final
    /// ranked order. Only `window` (= offset+limit) survive the slice, so the
    /// bounded selection avoids the full sort. The comparator is a strict total
    /// order (ends in `origIndex`), so this is identical to `sort().prefix(window)`.
    static func apply(_ results: inout [ResultHit], query: String, intent: Intent, window: Int)
        -> [ResultHit]
    {
        score(&results, query: query, intent: intent)
        return results.min(count: window, sortedBy: lessThan(_:_:))
    }

    /// Scores `results` in place and returns the FULL array sorted by the same
    /// total order. The semantic path needs every reranked hit (not just the top
    /// window) because hybrid fusion blends the complete lexical rank list with
    /// the semantic candidates — a hit beyond `window` can still surface once its
    /// semantic contribution is added. Mirrors JS `rerank`, which sorts the whole
    /// `results` array in place before `fuseSemanticResults` reads its order.
    static func applyFull(_ results: inout [ResultHit], query: String, intent: Intent) {
        score(&results, query: query, intent: intent)
        results.sort(by: lessThan)
    }

    /// The strict total order shared by `apply`/`applyFull`: score desc (0.001
    /// epsilon), then qualityOrder, then sourceOrder, then `origIndex` (the
    /// insertion-index tie-break that reproduces JS's stable sort).
    private static func lessThan(_ a: ResultHit, _ b: ResultHit) -> Bool {
        let scoreDiff = b.score - a.score
        if abs(scoreDiff) > 0.001 { return scoreDiff < 0 }  // higher score first
        let qa = qualityOrder[a.matchQuality] ?? 9
        let qb = qualityOrder[b.matchQuality] ?? 9
        if qa != qb { return qa < qb }
        let sa = sourceOrder[(a.sourceType ?? "").lowercased()] ?? 99
        let sb = sourceOrder[(b.sourceType ?? "").lowercased()] ?? 99
        if sa != sb { return sa < sb }
        return a.origIndex < b.origIndex
    }

    /// The R1-R11 scoring loop (no sort). Multipliers are applied in JS order so
    /// the `Double` results are bit-identical.
    private static func score(_ results: inout [ResultHit], query: String, intent: Intent) {
        let lowerQuery = query.lowercased()

        for i in results.indices {
            let r = results[i]
            let sourceType = (r.sourceType ?? "").lowercased()
            var score = baseScores[r.matchQuality] ?? 50

            // R1: exact path/title match
            let lastSegment = (r.path.split(separator: "/").last.map(String.init) ?? "").lowercased()
            if lastSegment == lowerQuery || (r.title ?? "").lowercased() == lowerQuery {
                score *= 3.0
                if r.title == query { score *= 1.1 }
            }
            // R2: symbol-kind boost
            if intent.type == .symbol, symbolKinds.contains((r.kind ?? "").lowercased()) {
                score *= 1.5
            }
            // R3: guide/article boost
            if intent.type == .howto {
                let kind = (r.kind ?? "").lowercased()
                if sourceType == "hig" || sourceType == "guidelines" || kind == "article" { score *= 1.3 }
            }
            // R4: release-notes penalty
            if r.isReleaseNotes || r.path.contains("release-notes") { score *= 0.4 }
            // R5: archived penalty
            if sourceType == "apple-archive" { score *= 0.6 }
            // R6: sample-code boost
            if sourceType == "sample-code" {
                if intent.type == .howto || lowerQuery.contains("example") || lowerQuery.contains("sample") {
                    score *= 1.2
                }
            }
            // R6b: package penalty
            if sourceType == "packages" {
                score *= 0.45
                if lowerQuery.contains("package") || lowerQuery.contains("library")
                    || (r.title ?? "").lowercased() == lowerQuery
                {
                    score *= 1.5
                }
            }
            // R7: source preference
            score *= sourceMultipliers[sourceType] ?? 1.0
            // R8: depth penalty
            if r.urlDepth > 0 { score *= max(0.3, 1.0 - Double(r.urlDepth) * 0.05) }
            // R9: error intent
            if intent.type == .error {
                let kind = (r.kind ?? "").lowercased()
                let title = (r.title ?? "").lowercased()
                if kind == "article" || title.contains("error") || title.contains("troubleshoot") {
                    score *= 1.2
                }
            }
            // R10: concept intent
            if intent.type == .concept {
                let kind = (r.kind ?? "").lowercased()
                if kind == "article" || sourceType == "hig" || sourceType == "swift-book" { score *= 1.2 }
            }
            // R11: WWDC intent
            if intent.type == .wwdc, sourceType == "wwdc" { score *= 1.4 }

            results[i].score = score
        }
    }
}

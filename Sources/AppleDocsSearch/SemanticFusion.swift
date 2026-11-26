import Foundation

/// Bun's lexical/semantic fusion (`search/fuse-semantic.js` + `search/fusion.js`): hybrid RRF with min–max
/// normalized scores (or plain weighted RRF), an exact-match block kept on top, then MMR diversification.
enum SemanticFusion {
    struct SemanticHit {
        let item: SearchResultItem
        let score: Double
        let bits: ArraySlice<UInt8>
    }

    static func fuse(
        lexical: [SearchResultItem],
        semantic: [SemanticHit],
        requestedWindow: Int
    ) -> [SearchResultItem] {
        let environment = ProcessInfo.processInfo.environment
        var results = lexical
        var seen = Set(lexical.map(\.path))
        let lexicalRanked = lexical.map(\.path)
        var lexicalScores: [String: Double] = [:]
        for item in lexical { lexicalScores[item.path] = item.score ?? 0 }
        var semanticRanked: [String] = []
        var semanticScores: [String: Double] = [:]
        var bitsByPath: [String: ArraySlice<UInt8>] = [:]
        for hit in semantic {
            semanticRanked.append(hit.item.path)
            semanticScores[hit.item.path] = hit.score
            bitsByPath[hit.item.path] = hit.bits
            if seen.insert(hit.item.path).inserted { results.append(hit.item) }
        }
        let lists = [(lexicalRanked, 1.0, lexicalScores), (semanticRanked, 0.6, semanticScores)]
        let fused = environment["APPLE_DOCS_FUSION"] == "rrf" ? weightedRRF(lists) : hybridFusion(lists, beta: 0.5)
        for index in results.indices { results[index].score = fused[results[index].path] ?? 0 }
        results = JSArraySort.sorted(results) { ($1.score ?? 0) - ($0.score ?? 0) }

        let exact = results.filter { $0.matchQuality == "exact" }
        if !exact.isEmpty, exact.count <= 5 {
            var position: [String: Int] = [:]
            for (index, path) in lexicalRanked.enumerated() where position[path] == nil { position[path] = index }
            let orderedExact = JSArraySort.sorted(exact) {
                Double(position[$0.path] ?? Int.max) - Double(position[$1.path] ?? Int.max)
            }
            results = orderedExact + results.filter { $0.matchQuality != "exact" }
        }

        guard environment["APPLE_DOCS_MMR"] != "off", !bitsByPath.isEmpty else { return results }
        let lambda = Double(environment["APPLE_DOCS_MMR_LAMBDA"] ?? "0.7").map { min(1, max(0, $0)) } ?? 0.7
        let window = min(results.count, max(requestedWindow, 20))
        let reordered = mmr(Array(results[..<window]), bits: bitsByPath, lambda: lambda)
        return reordered + results[window...]
    }

    /// `weightedRRF` (k = 60).
    static func weightedRRF(_ lists: [([String], Double, [String: Double])]) -> [String: Double] {
        var scores: [String: Double] = [:]
        for (ranked, weight, _) in lists {
            for (index, key) in ranked.enumerated() { scores[key, default: 0] += weight / Double(60 + index + 1) }
        }
        return scores
    }

    /// `hybridFusion` (k = 60): RRF plus `beta · weight ·` min–max normalized score.
    static func hybridFusion(_ lists: [([String], Double, [String: Double])], beta: Double) -> [String: Double] {
        var fused: [String: Double] = [:]
        for (ranked, weight, scores) in lists {
            let normalized = normalize(scores)
            for (index, key) in ranked.enumerated() {
                var add = weight / Double(60 + index + 1)
                add += beta * weight * (normalized[key] ?? 0)
                fused[key, default: 0] += add
            }
        }
        return fused
    }

    private static func normalize(_ scores: [String: Double]) -> [String: Double] {
        guard let low = scores.values.min(), let high = scores.values.max() else { return [:] }
        let range = high - low
        return scores.mapValues { range > 0 ? ($0 - low) / range : 0 }
    }

    /// `mmrSelect` with position-derived relevance and Hamming similarity between packed sign bits.
    static func mmr(
        _ ranked: [SearchResultItem],
        bits: [String: ArraySlice<UInt8>],
        lambda: Double
    ) -> [SearchResultItem] {
        let count = ranked.count
        guard count > 2 else { return ranked }
        let relevance = (0 ..< count).map { Double(count - $0) / Double(count) }
        let vectors = ranked.map { bits[$0.path] }
        var remaining = Array(1 ..< count)
        var selected = [0]
        while !remaining.isEmpty {
            var bestPosition = 0
            var bestScore = -Double.infinity
            for (position, candidate) in remaining.enumerated() {
                var maxSimilarity = 0.0
                if let vector = vectors[candidate] {
                    for chosen in selected {
                        guard let other = vectors[chosen] else { continue }
                        let width = min(vector.count, other.count)
                        let similarity =
                            1 - Double(SemanticCandidates.hamming(vector.prefix(width), other.prefix(width)))
                            / Double(width * 8)
                        if similarity > maxSimilarity { maxSimilarity = similarity }
                    }
                }
                let score = lambda * relevance[candidate] - (1 - lambda) * maxSimilarity
                if score > bestScore {
                    bestScore = score
                    bestPosition = position
                }
            }
            selected.append(remaining.remove(at: bestPosition))
        }
        return selected.map { ranked[$0] }
    }
}

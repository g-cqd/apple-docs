/// Score-aware Reciprocal Rank Fusion and Maximal Marginal Relevance diversity re-ranking
/// for hybrid lexical + `AemiSearch` + semantic candidate lists.
public enum HybridRankFusion: Sendable {
    /// A single ranked candidate list with relative weight and optional raw relevance scores.
    public struct RankedList: Hashable, Sendable {
        public let keys: [String]
        public let weight: Double
        public let scores: [String: Double]?

        public init(keys: [String], weight: Double, scores: [String: Double]? = nil) {
            self.keys = keys
            self.weight = weight
            self.scores = scores
        }
    }

    /// Min-max normalizes a score dictionary into `[0, 1]`.
    /// A degenerate range (empty, single element, or all equal) maps every entry to `0`.
    public static func normalizeScores(_ scores: [String: Double]) -> [String: Double] {
        guard !scores.isEmpty else { return [:] }
        var minScore = Double.infinity
        var maxScore = -Double.infinity
        for value in scores.values {
            if value < minScore { minScore = value }
            if value > maxScore { maxScore = value }
        }
        let range = maxScore - minScore
        var normalized: [String: Double] = [:]
        normalized.reserveCapacity(scores.count)
        for (key, value) in scores {
            normalized[key] = range > 0 ? (value - minScore) / range : 0
        }
        return normalized
    }

    /// Combines multiple ranked lists via weighted RRF plus optional `beta * weight * normalizedScore`.
    ///
    /// Weighting lexical lists above semantic lists preserves the exact-match dominance invariant
    /// while letting strong semantic/trigram candidates climb cleanly.
    public static func fuse(
        _ lists: [RankedList],
        k: Double = 60,
        beta: Double = 0.5
    ) -> [String: Double] {
        var fused: [String: Double] = [:]
        for list in lists {
            let norm = list.scores.map(normalizeScores)
            for (rank, key) in list.keys.enumerated() {
                var delta = list.weight / (k + Double(rank + 1))
                if let norm, let score = norm[key] {
                    delta += beta * list.weight * score
                }
                fused[key, default: 0] += delta
            }
        }
        return fused
    }

    /// Greedy Maximal Marginal Relevance (MMR) re-ranking over an already-ranked window.
    ///
    /// Items whose `vector` accessor returns `nil` carry redundancy `0`, keeping exact lexical
    /// symbol hits pinned while suppressing near-duplicate semantic overloads.
    public static func selectMMR<Item>(
        _ ranked: [Item],
        lambda: Double = 0.7,
        limit: Int? = nil,
        vector: (Item) -> [UInt8]?,
        similarity: ([UInt8], [UInt8]) -> Double
    ) -> [Item] {
        let count = ranked.count
        guard count > 2 else { return ranked }
        let cap = min(limit ?? count, count)
        let relevance = (0 ..< count).map { Double(count - $0) / Double(count) }
        let vectors = ranked.map(vector)
        var remaining = Array(0 ..< count)
        var selected: [Int] = [remaining.removeFirst()]
        selected.reserveCapacity(cap)

        while selected.count < cap, !remaining.isEmpty {
            var bestPos = 0
            var bestScore = -Double.infinity
            for (pos, idx) in remaining.enumerated() {
                var maxSim = 0.0
                if let candidateVec = vectors[idx] {
                    for chosenIdx in selected {
                        guard let chosenVec = vectors[chosenIdx] else { continue }
                        let sim = similarity(candidateVec, chosenVec)
                        if sim > maxSim { maxSim = sim }
                    }
                }
                let mmr = lambda * relevance[idx] - (1 - lambda) * maxSim
                if mmr > bestScore {
                    bestScore = mmr
                    bestPos = pos
                }
            }
            selected.append(remaining.remove(at: bestPos))
        }
        return selected.map { ranked[$0] } + remaining.map { ranked[$0] }
    }
}

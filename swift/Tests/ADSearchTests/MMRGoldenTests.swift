// Output-identity gate for the `MMR.select` rewrite (removed-bitset + memoized maxSim +
// `ADFCore.Popcount`). `reference` is the ORIGINAL O(cap²·n) algorithm, verbatim, kept here as the
// equivalence oracle; the property test asserts the live `MMR.select` returns the exact same
// permutation across many seeded inputs (varied n / dim / lambda / limit / presence).

import Testing

@testable import ADSearch

struct MMRGoldenTests {
    /// The original algorithm (pre-rewrite), verbatim — the equivalence oracle.
    static func reference(
        n: Int, dim: Int, vectors: UnsafeRawBufferPointer, presence: UnsafeRawBufferPointer,
        lambda: Double, limit: Int
    ) -> [UInt32] {
        if n <= 2 { return (0 ..< n).map(UInt32.init) }
        let cap = min(limit > 0 ? limit : n, n)
        var rel = [Double](repeating: 0, count: n)
        for i in 0 ..< n { rel[i] = Double(n - i) / Double(n) }
        func present(_ i: Int) -> Bool { (presence[i >> 3] >> (i & 7)) & 1 == 1 }
        func similarity(_ a: Int, _ b: Int) -> Double {
            var d = 0
            for i in 0 ..< dim {
                let x = vectors.load(fromByteOffset: a * dim + i, as: UInt8.self)
                let y = vectors.load(fromByteOffset: b * dim + i, as: UInt8.self)
                d += (x ^ y).nonzeroBitCount
            }
            return 1 - Double(d) / Double(dim * 8)
        }
        var remaining = Array(1 ..< n)
        var selected: [Int] = [0]
        while selected.count < cap && !remaining.isEmpty {
            var bestPos = 0
            var bestScore = -Double.infinity
            for p in 0 ..< remaining.count {
                let i = remaining[p]
                var maxSim = 0.0
                if present(i) {
                    for j in selected where present(j) {
                        let s = similarity(i, j)
                        if s > maxSim { maxSim = s }
                    }
                }
                let mmr = lambda * rel[i] - (1 - lambda) * maxSim
                if mmr > bestScore {
                    bestScore = mmr
                    bestPos = p
                }
            }
            selected.append(remaining.remove(at: bestPos))
        }
        var out = selected
        out.append(contentsOf: remaining)
        return out.map(UInt32.init)
    }

    @Test func matchesReferenceAcrossSeeds() {
        // Deterministic xorshift64 (no Foundation/RNG dep) so a failure is reproducible.
        var state: UInt64 = 0x9E37_79B9_7F4A_7C15
        func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }

        for _ in 0 ..< 400 {
            let n = 3 + Int(next() % 30)  // 3...32
            let dim = 1 + Int(next() % 16)  // 1...16
            let lambda = Double(next() % 1001) / 1000.0  // 0.0...1.0
            let limit = Int(next() % UInt64(n + 2))  // 0 (uncapped) ... n+1
            var vectors = [UInt8](repeating: 0, count: n * dim)
            for k in 0 ..< vectors.count { vectors[k] = UInt8(truncatingIfNeeded: next()) }
            var presence = [UInt8](repeating: 0, count: (n + 7) / 8)
            for k in 0 ..< presence.count { presence[k] = UInt8(truncatingIfNeeded: next()) }

            vectors.withUnsafeBytes { vp in
                presence.withUnsafeBytes { pp in
                    let expected = Self.reference(
                        n: n, dim: dim, vectors: vp, presence: pp, lambda: lambda, limit: limit)
                    let actual = MMR.select(
                        n: n, dim: dim, vectors: vp, presence: pp, lambda: lambda, limit: limit)
                    #expect(
                        actual == expected,
                        "MMR mismatch: n=\(n) dim=\(dim) lambda=\(lambda) limit=\(limit)")
                }
            }
        }
    }

    @Test func nLessThanThreeIsIdentity() {
        let empty = [UInt8](repeating: 0, count: 8)
        empty.withUnsafeBytes { p in
            #expect(MMR.select(n: 0, dim: 1, vectors: p, presence: p, lambda: 0.5, limit: 0) == [])
            #expect(MMR.select(n: 1, dim: 1, vectors: p, presence: p, lambda: 0.5, limit: 0) == [0])
            #expect(MMR.select(n: 2, dim: 1, vectors: p, presence: p, lambda: 0.5, limit: 0) == [0, 1])
        }
    }
}

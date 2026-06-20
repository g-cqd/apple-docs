// Maximal Marginal Relevance, mirrored bit-for-bit from `mmrSelect` with
// the production similarity baked in: 1 - hamming(a, b) / (dim * 8) over
// equal-length byte vectors. Scalar arithmetic only; see Fusion.swift for
// the parity rationale.

import ADFCore

public enum MMR {
    /// Returns the full output permutation (selected window, then the
    /// untouched tail in incoming order), as indices into the input order.
    ///
    /// - vectors: `n` rows of `dim` bytes (rows whose presence bit is 0 are
    ///   ignored; their contents are arbitrary).
    /// - presence: LSB-first bitmap, bit `i` = item `i` has a vector.
    /// - limit: 0 means uncapped (JS `limit ?? n`); the shim never encodes a
    ///   caller-supplied limit < 1.
    public static func select(
        n: Int,
        dim: Int,
        vectors: UnsafeRawBufferPointer,
        presence: UnsafeRawBufferPointer,
        lambda: Double,
        limit: Int
    ) -> [UInt32] {
        if n <= 2 { return (0 ..< n).map(UInt32.init) }
        let cap = min(limit > 0 ? limit : n, n)
        var rel = [Double](repeating: 0, count: n)
        for i in 0 ..< n { rel[i] = Double(n - i) / Double(n) }

        func present(_ i: Int) -> Bool {
            (presence[i >> 3] >> (i & 7)) & 1 == 1
        }
        // 1 - hamming(row a, row b) / (dim*8), through the shared bit-identical `ADFCore.Popcount`
        // kernel (SWAR; 8 bytes/step) — the same integer the per-byte `nonzeroBitCount` loop produced.
        func similarity(_ a: Int, _ b: Int) -> Double {
            let rowA = UnsafeRawBufferPointer(rebasing: vectors[(a * dim) ..< (a * dim + dim)])
            let rowB = UnsafeRawBufferPointer(rebasing: vectors[(b * dim) ..< (b * dim + dim)])
            return 1 - Double(Popcount.hammingDistance(rowA, rowB, count: dim)) / Double(dim * 8)
        }

        // O(cap·n·dim), down from O(cap²·n·dim): a removed-bitset gives O(1) logical removal (no
        // `remove(at:)` shift) preserving the original ascending order for the tail, and a memoized
        // per-candidate `maxSim` (max similarity to any already-selected item) is updated with ONLY the
        // newly-selected item each round — `maxSim` is monotonic, so this reproduces the full
        // recomputation exactly. Output is byte-identical to the original (hamming is exact; running max
        // is order-free; the smallest-index tie-break is preserved by the ascending scan).
        var removed = [Bool](repeating: false, count: n)
        var maxSim = [Double](repeating: 0, count: n)
        var selected: [Int] = []
        selected.reserveCapacity(cap)

        func selectAndFold(_ chosen: Int) {
            removed[chosen] = true
            selected.append(chosen)
            guard present(chosen) else { return }  // a non-present pick contributes no similarity
            for i in 0 ..< n where !removed[i] && present(i) {
                let s = similarity(i, chosen)
                if s > maxSim[i] { maxSim[i] = s }
            }
        }

        selectAndFold(0)  // item 0 is always the seed selection (mirrors the original)
        while selected.count < cap {
            var best = -1
            var bestScore = -Double.infinity
            for i in 0 ..< n where !removed[i] {
                let mmr = lambda * rel[i] - (1 - lambda) * maxSim[i]
                if mmr > bestScore {
                    bestScore = mmr
                    best = i
                }
            }
            if best < 0 { break }
            selectAndFold(best)
        }

        var out = selected
        for i in 0 ..< n where !removed[i] { out.append(i) }  // tail: never-selected, original order
        return out.map(UInt32.init)
    }
}

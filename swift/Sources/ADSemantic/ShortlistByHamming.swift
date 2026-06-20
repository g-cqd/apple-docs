// Bounded selection of the K smallest Hamming distances — the bit-exact port of
// `shortlistByHamming` in the JS reference (apple-docs src/search/semantic.js).
//
// The two family primitives do the work: ADFCore.Popcount (SWAR + byte-LUT, proven
// bit-identical) computes each chunk's Hamming distance to the query code, and
// ADFCore.BoundedTopK keeps the K smallest by the parity-exact (dist, idx) tie-break
// (admit while `d < root`, sift toward the larger child, emit ascending). What stays
// here is the domain glue: the n×width packed code store walk (index `i` is
// `i * width` into it) over unsafe bytes, feeding each (d, i) to the heap.

private import ADFCore

/// One shortlist entry — a row index into the chunk store and its Hamming
/// distance to the query code. `idx` is the load-bearing tie-break / lookup key
/// (it indexes the parallel `chunkDocId` / `chunkId` arrays).
struct HammingHit {
    let idx: Int
    let dist: Int
}

enum ShortlistByHamming {
    /// The K smallest Hamming distances of `qBin` against the `n` packed
    /// `width`-byte codes in `binPacked`, returned ascending by (dist, idx).
    /// `K` is clamped by the caller; `binPacked.count` must be ≥ `n * width`.
    static func select(qBin: [UInt8], binPacked: [UInt8], width: Int, n: Int, K: Int) -> [HammingHit] {
        guard K > 0, n > 0, width > 0 else { return [] }
        var heap = BoundedTopK(capacity: K)
        qBin.withUnsafeBytes { qBytes in
            binPacked.withUnsafeBytes { packedBytes in
                for i in 0 ..< n {
                    let base = UnsafeRawBufferPointer(
                        rebasing: packedBytes[(i * width) ..< (i * width + width)])
                    let d = Popcount.hammingDistance(qBytes, base, count: width)
                    heap.offer(dist: d, idx: i)
                }
            }
        }
        return heap.sortedAscending().map { HammingHit(idx: $0.idx, dist: $0.dist) }
    }
}

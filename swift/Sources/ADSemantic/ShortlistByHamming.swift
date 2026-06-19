// Bounded selection of the K smallest Hamming distances — the bit-exact port of
// `shortlistByHamming` in the JS reference (apple-docs src/search/semantic.js).
//
// A fixed-size binary MAX-heap of size ≤ K keyed by (dist, idx): the root is the
// "worst" kept candidate — largest distance, ties broken by largest index. The
// tie-break predicates are copied verbatim from the JS so the admitted set AND
// its final order match bit-for-bit:
//   - admit a new (d, i) iff `d < root distance` (strict);
//   - sift up while a parent is smaller by (dist, idx)  — break when
//     `heapDist[p] > d || (heapDist[p] == d && heapIdx[p] > i)`;
//   - sift down toward the LARGER child by (dist, idx);
//   - on the way out, collect `size` elements and sort ascending by (dist, idx).
//
// The Hamming distance uses ADFCore.Popcount (SWAR + byte-LUT, proven
// bit-identical), the family-wide primitive. `binPacked` is the n×width packed
// code store; index `i` is `i * width` into it.

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
        var heapDist = [Int](repeating: 0, count: K)
        var heapIdx = [Int](repeating: 0, count: K)
        var size = 0

        qBin.withUnsafeBytes { qBytes in
            binPacked.withUnsafeBytes { packedBytes in
                for i in 0 ..< n {
                    let base = UnsafeRawBufferPointer(
                        rebasing: packedBytes[(i * width) ..< (i * width + width)])
                    let d = Popcount.hammingDistance(qBytes, base, count: width)
                    if size < K {
                        // sift up: bubble (d, i) toward the root while parents are smaller.
                        var c = size
                        size += 1
                        while c > 0 {
                            let p = (c - 1) >> 1
                            if heapDist[p] > d || (heapDist[p] == d && heapIdx[p] > i) { break }
                            heapDist[c] = heapDist[p]
                            heapIdx[c] = heapIdx[p]
                            c = p
                        }
                        heapDist[c] = d
                        heapIdx[c] = i
                    } else if d < heapDist[0] {
                        // replace the root, then sift down toward the larger child by (dist, idx).
                        var c = 0
                        while true {
                            let l = 2 * c + 1
                            let r = l + 1
                            var bigDist = d
                            var bigIdx = i
                            var big = -1
                            if l < K && (heapDist[l] > bigDist || (heapDist[l] == bigDist && heapIdx[l] > bigIdx)) {
                                big = l
                                bigDist = heapDist[l]
                                bigIdx = heapIdx[l]
                            }
                            if r < K && (heapDist[r] > bigDist || (heapDist[r] == bigDist && heapIdx[r] > bigIdx)) {
                                big = r
                            }
                            if big == -1 { break }
                            heapDist[c] = heapDist[big]
                            heapIdx[c] = heapIdx[big]
                            c = big
                        }
                        heapDist[c] = d
                        heapIdx[c] = i
                    }
                }
            }
        }

        var out: [HammingHit] = []
        out.reserveCapacity(size)
        for r in 0 ..< size { out.append(HammingHit(idx: heapIdx[r], dist: heapDist[r])) }
        // Ascending by (dist, idx) — matches the JS `a.dist - b.dist || a.idx - b.idx`.
        out.sort { lhs, rhs in lhs.dist != rhs.dist ? lhs.dist < rhs.dist : lhs.idx < rhs.idx }
        return out
    }
}

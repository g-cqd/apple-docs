import AppleDocsKernels

/// Single-pass SIMD Hamming shortlist over ``ChunkVectorStore``: tile-wise `adk_hamming_batch` (NEON `vcntq_u8` /
/// AVX2 `vpshufb` / SSE4.2 `popcntq`) into a tiny L1-resident tile buffer (`4,096 × UInt16` = 8 KiB) + monotonic
/// bucket cutoff, avoiding the 3.9 MiB `[UInt16]` heap allocation + `_platform_bzero` + second 983k-row pass while
/// preserving exact `(distance, index)` tie-breaking.
extension SemanticCandidates {
    private static let tileRows = 4_096

    /// Top `size` entries of `store` by Hamming distance to `queryBits`, ties broken by ascending `index`.
    static func shortlist(_ queryBits: [UInt8], store: ChunkVectorStore, size: Int) -> [Entry] {
        guard size > 0, store.count > 0, queryBits.count >= store.byteWidth else { return [] }
        let width = store.byteWidth
        let maxBits = width * 8
        var counts = [Int](repeating: 0, count: maxBits + 1)
        var buckets = [[Int]](repeating: [], count: maxBits + 1)
        var cutoff = maxBits
        var withinCutoff = 0
        var tile = [UInt16](repeating: 0, count: min(tileRows, store.count))

        queryBits.withUnsafeBufferPointer { qBuf in
            store.packed.withUnsafeBufferPointer { pBuf in
                tile.withUnsafeMutableBufferPointer { tBuf in
                    guard let qBase = qBuf.baseAddress,
                        let pBase = pBuf.baseAddress,
                        let tBase = tBuf.baseAddress
                    else { return }
                    var cursor = 0
                    while cursor < store.count {
                        let count = min(tileRows, store.count - cursor)
                        unsafe AppleDocsKernels.hammingBatch(
                            query: qBase,
                            packed: pBase + cursor * width,
                            rowCount: count,
                            byteWidth: width,
                            into: tBase
                        )
                        for offset in 0 ..< count {
                            let dist = Int(unsafe tBase[offset])
                            guard dist <= cutoff else { continue }
                            counts[dist] += 1
                            buckets[dist].append(cursor + offset)
                            withinCutoff += 1
                            while cutoff > 0, withinCutoff - counts[cutoff] >= size {
                                withinCutoff -= counts[cutoff]
                                buckets[cutoff].removeAll(keepingCapacity: false)
                                cutoff -= 1
                            }
                        }
                        cursor += count
                    }
                }
            }
        }
        var out: [Entry] = []
        out.reserveCapacity(size)
        for d in 0 ... cutoff {
            for idx in buckets[d] {
                out.append(Entry(index: idx, distance: d))
                if out.count == size { return out }
            }
        }
        return out
    }
}

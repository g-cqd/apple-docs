/// Quantization, Hamming distance, int8 rescoring, and bounded top-K heap selection
/// for offline binary/int8 semantic embeddings (`model2vec` / `document_vectors` / `document_chunks`).
///
/// Uses a fixed-size binary max-heap keyed by `(distance, index)` so scanning hundreds of
/// thousands of packed 512-bit codes allocates O(K) scratch memory with O(N log K) time.
public enum BinaryVectorScorer: Sendable {
    /// Single top-K match returned by ``shortlist(query:packedCodes:codeByteWidth:topK:)``.
    public struct ShortlistEntry: Hashable, Sendable {
        public let index: Int
        public let distance: Int

        public init(index: Int, distance: Int) {
            self.index = index
            self.distance = distance
        }
    }

    /// Sign-quantizes an `fp32` embedding into a packed bit-vector (MSB-first per byte).
    public static func quantizeBinary(_ vector: [Float]) -> [UInt8] {
        let byteWidth = (vector.count + 7) / 8
        var out = [UInt8](repeating: 0, count: byteWidth)
        for (idx, value) in vector.enumerated() where value > 0 {
            out[idx >> 3] |= UInt8(1 << (7 - (idx & 7)))
        }
        return out
    }

    /// Computes Hamming bit distance between two equally-sized packed binary codes.
    public static func hammingDistance(_ lhs: [UInt8], _ rhs: [UInt8]) -> Int {
        let count = min(lhs.count, rhs.count)
        var distance = 0
        for idx in 0 ..< count {
            distance += Int((lhs[idx] ^ rhs[idx]).nonzeroBitCount)
        }
        return distance
    }

    /// Normalized binary cosine-like similarity in `[0, 1]` from Hamming distance.
    public static func binarySimilarity(_ lhs: [UInt8], _ rhs: [UInt8]) -> Double {
        let bits = min(lhs.count, rhs.count) * 8
        guard bits > 0 else { return 0 }
        return 1.0 - Double(hammingDistance(lhs, rhs)) / Double(bits)
    }

    /// Rescores a full-precision `query` vector against an `int8 + f32-scale` payload (`dims + 4` bytes).
    ///
    /// Layout matches `apple-docs` `document_chunks.vec_i8`: first `dims` signed int8 values followed
    /// by a little-endian IEEE-754 float32 scale factor.
    public static func dotInt8(query: [Float], quantizedPayload: [UInt8]) -> Float {
        let dims = query.count
        guard quantizedPayload.count == dims + 4 else { return 0 }
        var sum: Float = 0
        for idx in 0 ..< dims {
            let signed = Int8(bitPattern: quantizedPayload[idx])
            sum += query[idx] * Float(signed)
        }
        let scaleBits =
            UInt32(quantizedPayload[dims])
            | (UInt32(quantizedPayload[dims + 1]) << 8)
            | (UInt32(quantizedPayload[dims + 2]) << 16)
            | (UInt32(quantizedPayload[dims + 3]) << 24)
        return sum * Float(bitPattern: scaleBits)
    }

    /// Selects the `topK` closest packed binary codes in a single linear pass using a bounded max-heap.
    public static func shortlist(
        query: [UInt8],
        packedCodes: [UInt8],
        codeByteWidth: Int,
        topK: Int
    ) -> [ShortlistEntry] {
        guard codeByteWidth > 0, topK > 0, query.count == codeByteWidth else { return [] }
        let codeCount = packedCodes.count / codeByteWidth
        guard codeCount > 0 else { return [] }

        let cap = min(topK, codeCount)
        var heap: [ShortlistEntry] = []
        heap.reserveCapacity(cap)

        for idx in 0 ..< codeCount {
            let base = idx * codeByteWidth
            var distance = 0
            for byteOffset in 0 ..< codeByteWidth {
                distance += Int((query[byteOffset] ^ packedCodes[base + byteOffset]).nonzeroBitCount)
            }
            let candidate = ShortlistEntry(index: idx, distance: distance)
            if heap.count < cap {
                heap.append(candidate)
                siftUp(&heap, from: heap.count - 1)
            } else if candidate.distance < heap[0].distance {
                heap[0] = candidate
                siftDown(&heap, from: 0)
            }
        }
        return heap.sorted { lhs, rhs in
            lhs.distance != rhs.distance ? lhs.distance < rhs.distance : lhs.index < rhs.index
        }
    }

    private static func isWorse(_ lhs: ShortlistEntry, than rhs: ShortlistEntry) -> Bool {
        lhs.distance != rhs.distance ? lhs.distance > rhs.distance : lhs.index > rhs.index
    }

    private static func siftUp(_ heap: inout [ShortlistEntry], from start: Int) {
        var child = start
        while child > 0 {
            let parent = (child - 1) >> 1
            guard isWorse(heap[child], than: heap[parent]) else { break }
            heap.swapAt(child, parent)
            child = parent
        }
    }

    private static func siftDown(_ heap: inout [ShortlistEntry], from start: Int) {
        let count = heap.count
        var parent = start
        while true {
            let left = parent * 2 + 1
            let right = left + 1
            var worst = parent
            if left < count, isWorse(heap[left], than: heap[worst]) { worst = left }
            if right < count, isWorse(heap[right], than: heap[worst]) { worst = right }
            guard worst != parent else { break }
            heap.swapAt(parent, worst)
            parent = worst
        }
    }
}

import AppleDocsStorage
import Foundation

/// Bun's semantic candidate retrieval (`semanticCandidates` in `search/semantic.js`): Hamming shortlist over sign
/// bits, then (chunk mode) int8 dot-product rescoring, best chunk per document, top `topK` by score.
enum SemanticCandidates {
    struct Candidate {
        let documentID: Int64
        let distance: Int
        let score: Double
        /// The winning entry's packed sign bits (for MMR diversity).
        let bits: ArraySlice<UInt8>
    }

    static func candidates(
        query vector: [Float],
        store: ChunkVectorStore,
        topK: Int = 50,
        on connection: SQLiteConnection
    ) -> [Candidate] {
        guard vector.count == store.dimensions else { return [] }
        let queryBits = quantize(vector, dimensions: store.dimensions)
        let bitCount = Double(store.byteWidth * 8)
        guard store.mode == .chunk else {
            return shortlist(queryBits, store: store, size: topK)
                .map { entry in
                    Candidate(
                        documentID: store.documentIDs[entry.index],
                        distance: entry.distance,
                        score: 1 - Double(entry.distance) / bitCount,
                        bits: store.bits(at: entry.index)
                    )
                }
        }
        let environment = ProcessInfo.processInfo.environment
        let shortlistSize = clamp(environment["APPLE_DOCS_SEMANTIC_SHORTLIST"], fallback: 200, range: 16 ... 5_000)
        let entries = shortlist(queryBits, store: store, size: shortlistSize)
        let int8 =
            environment["APPLE_DOCS_RESCORE"] == "off"
            ? [:] : int8Vectors(entries.map { store.chunkIDs[$0.index] }, on: connection)
        var order: [Int64] = []
        var best: [Int64: (score: Double, distance: Int, index: Int)] = [:]
        for entry in entries {
            var score = 1 - Double(entry.distance) / bitCount
            if let packed = int8[store.chunkIDs[entry.index]], packed.count == store.dimensions + 4 {
                score = dotInt8(vector, packed, dimensions: store.dimensions)
            }
            let document = store.documentIDs[entry.index]
            if let previous = best[document] {
                if score > previous.score { best[document] = (score, entry.distance, entry.index) }
            } else {
                order.append(document)
                best[document] = (score, entry.distance, entry.index)
            }
        }
        let candidates = order.compactMap { document -> Candidate? in
            guard let value = best[document] else { return nil }
            return Candidate(
                documentID: document,
                distance: value.distance,
                score: value.score,
                bits: store.bits(at: value.index)
            )
        }
        return Array(JSArraySort.sorted(candidates) { $1.score - $0.score }.prefix(topK))
    }

    /// `quantizeTo`: bit `i` set when component `i` is `>= 0`.
    static func quantize(_ vector: [Float], dimensions: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: (dimensions + 7) / 8)
        for index in 0 ..< min(vector.count, dimensions) where vector[index] >= 0 {
            out[index >> 3] |= 1 << UInt8(index & 7)
        }
        return out
    }

    /// `dotI8`: `Σ q[i]·i8[i]` in double precision, times the trailing little-endian float32 scale.
    static func dotInt8(_ query: [Float], _ packed: [UInt8], dimensions: Int) -> Double {
        var dot = 0.0
        for index in 0 ..< dimensions {
            dot += Double(query[index]) * Double(Int8(bitPattern: packed[index]))
        }
        let scaleBits =
            UInt32(packed[dimensions]) | UInt32(packed[dimensions + 1]) << 8 | UInt32(packed[dimensions + 2]) << 16
            | UInt32(packed[dimensions + 3]) << 24
        return dot * Double(Float(bitPattern: scaleBits))
    }

    static func hamming(_ lhs: ArraySlice<UInt8>, _ rhs: ArraySlice<UInt8>) -> Int {
        var distance = 0
        for (left, right) in zip(lhs, rhs) { distance += (left ^ right).nonzeroBitCount }
        return distance
    }

    private static func int8Vectors(_ chunkIDs: [Int64], on connection: SQLiteConnection) -> [Int64: [UInt8]] {
        var out: [Int64: [UInt8]] = [:]
        for start in stride(from: 0, to: chunkIDs.count, by: 500) {
            let batch = chunkIDs[start ..< min(start + 500, chunkIDs.count)]
            let sql =
                "SELECT chunk_id, vec_i8 FROM document_chunks WHERE chunk_id IN ("
                + SQLiteConnection.placeholders(batch.count) + ")"
            for row in (try? connection.query(sql, bindings: batch.map(SQLiteValue.integer))) ?? [] {
                if let id = try? row.integer(at: 0), let bytes = try? row.optionalBlob(at: 1) { out[id] = bytes }
            }
        }
        return out
    }

    private static func clamp(_ raw: String?, fallback: Int, range: ClosedRange<Int>) -> Int {
        guard let raw, let value = Int(raw) else { return fallback }
        return min(range.upperBound, max(range.lowerBound, value))
    }
}

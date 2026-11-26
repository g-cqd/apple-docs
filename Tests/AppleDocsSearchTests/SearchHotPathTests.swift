import AemiSearch
import AppleDocsCore
import AppleDocsStorage
import Testing

@testable import AppleDocsSearch

@Suite("Hot-path search optimizations (Hamming shortlist, Q8 lazy rows, stopword FTS)")
struct SearchHotPathTests {
    @Test func `single-pass parallel Hamming shortlist matches exact tie-breaking across >10k chunks`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let dims = 64
        let bytesPerVec = dims / 8
        let docCount = 512
        let chunksPerDoc = 24  // 12,288 chunks -> exercises multi-slice parallel shortlist

        var docIDs: [Int64] = []
        docIDs.reserveCapacity(docCount)
        try store.connection.transaction {
            for idx in 0 ..< docCount {
                let id = try store.upsertDocument(
                    DocumentRecord(
                        key: try DocumentKey("swiftui/item-\(idx)"),
                        title: "Item \(idx)",
                        framework: "swiftui"
                    )
                )
                docIDs.append(id)
                for ord in 0 ..< chunksPerDoc {
                    let seed = UInt64(idx * 31 + ord * 7 + 1)
                    var vec = [UInt8](repeating: 0, count: bytesPerVec)
                    for b in 0 ..< bytesPerVec {
                        vec[b] = UInt8(truncatingIfNeeded: seed &* UInt64(b + 3) ^ (seed >> 3))
                    }
                    var i8 = [UInt8](repeating: 10, count: dims)
                    let scaleBits = Float(0.01).bitPattern.littleEndian
                    withUnsafeBytes(of: scaleBits) { i8.append(contentsOf: $0) }
                    try store.connection.execute(
                        "INSERT INTO document_chunks (document_id, ord, vec_bin, vec_i8) VALUES (?, ?, ?, ?)",
                        bindings: [.integer(id), .integer(Int64(ord)), .blob(vec), .blob(i8)]
                    )
                }
            }
        }

        let vectors = try #require(try ChunkVectorStore.load(from: store.connection))
        #expect(vectors.count == docCount * chunksPerDoc)

        let queryBits = [UInt8](repeating: 0xAA, count: bytesPerVec)
        let limit = 150

        // Reference two-pass shortlist (exact previous behavior: ascending distance, then ascending index).
        var all: [(index: Int, dist: Int)] = []
        all.reserveCapacity(vectors.count)
        for index in 0 ..< vectors.count {
            let base = index * bytesPerVec
            var d = 0
            for b in 0 ..< bytesPerVec { d += (queryBits[b] ^ vectors.packed[base + b]).nonzeroBitCount }
            all.append((index, d))
        }
        all.sort { $0.dist != $1.dist ? $0.dist < $1.dist : $0.index < $1.index }
        let expected = Array(all.prefix(limit))

        let actual = SemanticCandidates.shortlist(queryBits, store: vectors, size: limit)
        #expect(actual.map(\.index) == expected.map(\.index))
        #expect(actual.map(\.distance) == expected.map(\.dist))
    }

    @Test func `Model2VecEmbedder over compact Q8 storage produces bit-identical vectors to float32 matrix`() throws {
        let tokenizerJSON = """
            {
                "normalizer": {"type": "BertNormalizer", "lowercase": true, "clean_text": true},
                "pre_tokenizer": {"type": "BertPreTokenizer"},
                "model": {
                    "type": "WordPiece",
                    "unk_token": "[UNK]",
                    "continuing_subword_prefix": "##",
                    "vocab": {"[PAD]": 0, "[UNK]": 1, "swift": 2, "##ui": 3, "view": 4, "stack": 5}
                }
            }
            """
        let tokenizer = try WordPieceTokenizer(tokenizerJSON: Array(tokenizerJSON.utf8))
        let original = Model2VecEmbedder.EmbeddingMatrix(
            rows: 6,
            dims: 8,
            weights: (0 ..< 48).map { Float(($0 % 11) - 5) * 0.125 }
        )
        let q8Bytes = Model2VecEmbedder.quantizeQ8(original)
        let eagerMatrix = try Model2VecEmbedder.parseQ8Matrix(q8Bytes)
        let eagerEmbedder = Model2VecEmbedder(tokenizer: tokenizer, matrix: eagerMatrix)
        let compactEmbedder = try Model2VecEmbedder(tokenizer: tokenizer, q8Bytes: q8Bytes)

        #expect(compactEmbedder.dimensions == 8)
        #expect(compactEmbedder.isCompactQ8)
        #expect(!eagerEmbedder.isCompactQ8)
        for sample in ["SwiftUI View", "stack view", "unknown", ""] {
            #expect(compactEmbedder.embed(sample) == eagerEmbedder.embed(sample))
        }
    }

    @Test func `FTSQueryBuilder emits exact match (not prefix wildcard) on 1-2 letter ASCII stopwords`() {
        #expect(
            FTSQueryBuilder.buildLexicalQuery("performing calculations on a gpu")
                == #""performing"* "calculations"* "on" "a" "gpu"*"#
        )
        #expect(
            FTSQueryBuilder.buildLexicalQuery("how to compress data in swift")
                == #""how"* "to" "compress"* "data"* "in" "swift"*"#
        )
        // Non-stopword 2-letter technical tokens still get prefix matching (`os` -> `oslog`, `ui` -> `uiview`).
        #expect(FTSQueryBuilder.buildLexicalQuery("os ui") == #""os"* "ui"*"#)
    }
}

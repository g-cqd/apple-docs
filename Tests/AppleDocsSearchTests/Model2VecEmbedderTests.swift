import AemiProtobuf
import AemiSearch
import AppleDocsCore
import AppleDocsStorage
import Foundation
import Testing

@testable import AppleDocsSearch

@Suite("Model2VecEmbedder & WordPieceTokenizer")
struct Model2VecEmbedderTests {
    @Test func `tokenizes with BertNormalizer, punctuation splitting, accent stripping, and WordPiece subwords`() throws
    {
        let tokenizerJSON = """
            {
                "normalizer": {"type": "BertNormalizer", "lowercase": true, "clean_text": true},
                "pre_tokenizer": {"type": "BertPreTokenizer"},
                "model": {
                    "type": "WordPiece",
                    "unk_token": "[UNK]",
                    "continuing_subword_prefix": "##",
                    "vocab": {
                        "[PAD]": 0,
                        "[UNK]": 1,
                        "swift": 2,
                        "##ui": 3,
                        "view": 4,
                        ".": 5,
                        "cafe": 6
                    }
                }
            }
            """
        let tokenizer = try WordPieceTokenizer(tokenizerJSON: Array(tokenizerJSON.utf8))
        #expect(tokenizer.vocabularySize == 7)
        #expect(tokenizer.encode("SwiftUI.View Café") == [2, 3, 5, 4, 6])
        #expect(tokenizer.encode("unknownword") == [1])
    }

    @Test func `round-trips M2VQ8 quantization and decodes synthetic ONNX protobuf via AemiProtobuf`() throws {
        let original = Model2VecEmbedder.EmbeddingMatrix(
            rows: 3,
            dims: 4,
            weights: [
                0.0, 0.0, 0.0, 0.0,
                1.0, -0.5, 0.25, 0.75,
                -0.25, 0.5, 1.0, -0.5
            ]
        )

        // 1. M2VQ8 round-trip
        let q8Bytes = Model2VecEmbedder.quantizeQ8(original)
        let decodedQ8 = try Model2VecEmbedder.parseQ8Matrix(q8Bytes)
        #expect(decodedQ8.rows == 3)
        #expect(decodedQ8.dims == 4)
        for idx in 0 ..< original.weights.count {
            #expect(abs(decodedQ8.weights[idx] - original.weights[idx]) < 0.02)
        }

        // 2. ONNX protobuf extraction using AemiProtobuf WireWriter -> WireReader
        var rawFloatBytes: [UInt8] = []
        rawFloatBytes.reserveCapacity(original.weights.count * 4)
        for value in original.weights {
            let bits = value.bitPattern
            rawFloatBytes.append(UInt8(truncatingIfNeeded: bits))
            rawFloatBytes.append(UInt8(truncatingIfNeeded: bits >> 8))
            rawFloatBytes.append(UInt8(truncatingIfNeeded: bits >> 16))
            rawFloatBytes.append(UInt8(truncatingIfNeeded: bits >> 24))
        }

        var tensorWriter = WireWriter()
        tensorWriter.appendPackedVarints(field: 1, [Int64(3), Int64(4)])
        tensorWriter.appendTag(2, .varint)
        tensorWriter.appendVarint(1)  // TensorProto.DataType.FLOAT
        tensorWriter.appendTag(9, .lengthDelimited)
        tensorWriter.appendBytes(rawFloatBytes)

        var graphWriter = WireWriter()
        graphWriter.appendTag(5, .lengthDelimited)
        graphWriter.appendBytes(tensorWriter.bytes)

        var modelWriter = WireWriter()
        modelWriter.appendTag(7, .lengthDelimited)
        modelWriter.appendBytes(graphWriter.bytes)

        let extracted = try Model2VecEmbedder.extractONNXEmbeddingMatrix(modelWriter.bytes)
        #expect(extracted == original)
    }

    @Test func `embeds text into unit L2-normalized vectors matching real local potion-retrieval-32M if present`()
        throws
    {
        let modelDir = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".apple-docs/resources/models/minishlab/potion-retrieval-32M")
        guard FileManager.default.fileExists(atPath: modelDir.appendingPathComponent("model2vec.q8").path) else {
            return
        }
        let embedder = try Model2VecEmbedder(modelDirectory: modelDir.path)
        #expect(embedder.matrix.dims == 512)
        let vNav = embedder.embed("SwiftUI NavigationStack push view")
        let vNav2 = embedder.embed("SwiftUI navigation stack views")
        let vMetal = embedder.embed("Metal GPU compute shader pipeline")
        #expect(vNav.count == 512)

        let norm = sqrt(vNav.reduce(0.0) { $0 + Double($1) * Double($1) })
        #expect(abs(norm - 1.0) < 1e-4)

        let simRelated = zip(vNav, vNav2).reduce(0.0) { $0 + Double($1.0) * Double($1.1) }
        let simUnrelated = zip(vNav, vMetal).reduce(0.0) { $0 + Double($1.0) * Double($1.1) }
        #expect(simRelated > simUnrelated)
    }

    @Test func `chunk vectors shortlist by Hamming, rescore with int8, and keep each document's best chunk`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let id1 = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("swiftui/view"), title: "View", framework: "swiftui")
        )
        let id2 = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("metal/mtlbuffer"), title: "MTLBuffer", framework: "metal")
        )
        let query: [Float] = [0.5, 0.5, 0.5, 0.5, -0.5, -0.5, -0.5, -0.5]
        func int8(_ values: [Int8], scale: Float) -> [UInt8] {
            values.map { UInt8(bitPattern: $0) } + withUnsafeBytes(of: scale.bitPattern.littleEndian, Array.init)
        }
        struct Chunk {
            let document: Int64
            let ord: Int64
            let vector: [Float]
            let quantized: [Int8]
        }
        let chunks = [
            Chunk(
                document: id1,
                ord: 0,
                vector: [1, 1, 1, 1, -1, -1, -1, -1],
                quantized: [100, 100, 100, 100, -100, -100, -100, -100]
            ),
            Chunk(
                document: id1,
                ord: 1,
                vector: [1, 1, -1, -1, 1, 1, -1, -1],
                quantized: [10, 10, -10, -10, 10, 10, -10, -10]
            ),
            Chunk(
                document: id2,
                ord: 0,
                vector: [-1, -1, -1, -1, 1, 1, 1, 1],
                quantized: [-100, -100, -100, -100, 100, 100, 100, 100]
            )
        ]
        for chunk in chunks {
            try store.connection.execute(
                "INSERT INTO document_chunks (document_id, ord, vec_bin, vec_i8) VALUES (?, ?, ?, ?)",
                bindings: [
                    .integer(chunk.document), .integer(chunk.ord),
                    .blob(SemanticCandidates.quantize(chunk.vector, dimensions: 8)),
                    .blob(int8(chunk.quantized, scale: 0.01))
                ]
            )
        }
        let vectors = try #require(try ChunkVectorStore.load(from: store.connection))
        #expect(vectors.mode == .chunk && vectors.count == 3 && vectors.dimensions == 8)

        let candidates = SemanticCandidates.candidates(query: query, store: vectors, topK: 5, on: store.connection)
        #expect(candidates.map(\.documentID) == [id1, id2])
        #expect(abs(candidates[0].score - 4.0) < 1e-6)  // Σ |0.5·100| over 8 dims · scale 0.01
        #expect(candidates[0].distance == 0)
    }
}

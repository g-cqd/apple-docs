import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSearch
import AppleDocsStorage
import Testing

@Suite("Chunk embedding index (Bun commands/index-embeddings.js)")
struct ChunkEmbeddingIndexerTests {
    private func embedder() throws -> Model2VecEmbedder {
        let tokenizer = """
            {"normalizer":{"type":"BertNormalizer"},"pre_tokenizer":{"type":"BertPreTokenizer"},
             "model":{"type":"WordPiece","vocab":{"[UNK]":0,"view":1,"stack":2,"text":3,"overview":4}}}
            """
        var weights = [Float](repeating: 0, count: 5 * 4)
        for row in 0 ..< 5 {
            for column in 0 ..< 4 { weights[row * 4 + column] = Float((row + 1) * (column % 2 == 0 ? 1 : -1)) }
        }
        return Model2VecEmbedder(
            tokenizer: try WordPieceTokenizer(tokenizerJSON: Array(tokenizer.utf8)),
            matrix: Model2VecEmbedder.EmbeddingMatrix(rows: 5, dims: 4, weights: weights)
        )
    }

    @Test func `indexes chunks with sign-bit and int8 vectors, then only new or updated documents`() async throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let view = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("swiftui/view"), title: "View", abstractText: "A view.")
        )
        try store.replaceSections(
            forDocumentID: view,
            sections: [
                DocumentSectionRecord(sectionKind: "discussion", heading: "Overview", contentText: "Stack text.")
            ]
        )
        let embedder = try embedder()
        let first = try await ChunkEmbeddingIndexer.run(store: store, embedder: embedder, modelName: "test-model")
        #expect(first.documents == 1 && first.chunks == 2)

        let rows = try store.connection.query("SELECT ord, vec_bin, vec_i8 FROM document_chunks ORDER BY ord")
        #expect(rows.count == 2)
        let anchorVector = embedder.embed("View. A view.")
        #expect(try rows[0].optionalBlob(at: 1) == EmbeddingQuantizer.signBits(anchorVector))
        #expect(try rows[0].optionalBlob(at: 2) == EmbeddingQuantizer.int8(anchorVector))
        #expect(try rows[1].optionalBlob(at: 2) == EmbeddingQuantizer.int8(embedder.embed("Overview. Stack text.")))
        let anchor = try store.connection.queryOne(
            "SELECT vec FROM document_vectors WHERE document_id = ?",
            bindings: [.integer(view)]
        )
        #expect(try anchor?.optionalBlob(at: 0) == EmbeddingQuantizer.signBits(anchorVector))
        let meta = try store.connection.query("SELECT key, value FROM snapshot_meta ORDER BY key")
        #expect(
            try meta.map { "\(try $0.text(at: 0))=\(try $0.text(at: 1))" } == ["embed_dims=4", "embed_model=test-model"]
        )

        #expect(
            try await ChunkEmbeddingIndexer.run(store: store, embedder: embedder, modelName: "test-model").documents
                == 0
        )
        _ = try store.upsertDocument(DocumentRecord(key: try DocumentKey("swiftui/text"), title: "Text"))
        let incremental = try await ChunkEmbeddingIndexer.run(store: store, embedder: embedder, modelName: "test-model")
        #expect(incremental.documents == 1 && incremental.chunks == 1)
        let full = try await ChunkEmbeddingIndexer.run(
            store: store,
            embedder: embedder,
            modelName: "test-model",
            full: true
        )
        #expect(full.documents == 2 && full.chunks == 3)
        #expect(try store.connection.queryOne("SELECT COUNT(*) FROM document_chunks")?.integer(at: 0) == 3)
    }
}

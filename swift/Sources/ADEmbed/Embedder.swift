// The model2vec embedder: Tokenizer + MatrixArtifact → unit-norm f32
// vectors. ids = tokenize(text) with the `[0]` ([PAD] row) substitution for
// empty outputs, then normalize(mean(rows)) per the probed graph semantics
// (Pooling.swift). No truncation, no extra normalization — the model2vec
// path applies neither.

public struct Embedder: Sendable {
    public enum EmbedError: Error, Equatable {
        case missingRow(tokenId: Int32)
        case widthMismatch(matrixDims: Int)
    }

    private let tokenizer: Tokenizer
    private let matrix: MatrixArtifact
    public let dims: Int

    public init(tokenizer: Tokenizer, matrix: MatrixArtifact) {
        self.tokenizer = tokenizer
        self.matrix = matrix
        self.dims = matrix.dims
    }

    public func embed(_ text: String) throws(EmbedError) -> [Float] {
        var ids = tokenizer.encode(text)
        if ids.isEmpty { ids = [0] }  // EmbeddingBag needs ≥1 token
        // Mean-pool the token rows straight from the matrix's mmap: fold each row into `out` as it is
        // visited (bag order), then finalize (mean + L2 normalize). Each row is read through a
        // `Span<Float>` whose lifetime the compiler bounds to the closure, so no row pointer escapes and
        // no intermediate `[UnsafePointer<Float>]` is allocated. The accumulation order is unchanged, so
        // the result stays bit-identical to the onnxruntime reference (see `Pooling`).
        var out = [Float](repeating: 0, count: dims)
        for id in ids {
            guard id >= 0 else { throw .missingRow(tokenId: id) }
            let visited: Void? = matrix.withRow(forTokenId: UInt32(id)) { row in
                for i in 0 ..< dims { out[i] += row[i] }
            }
            guard visited != nil else { throw .missingRow(tokenId: id) }
        }
        Pooling.finalizeMeanNormalized(&out, count: ids.count)
        return out
    }

    public func embedBatch(_ texts: [String]) throws(EmbedError) -> [[Float]] {
        var results: [[Float]] = []
        results.reserveCapacity(texts.count)
        for text in texts {
            results.append(try embed(text))
        }
        return results
    }
}

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
    // The row pointers alias `self.matrix`'s mmap; the stored `matrix` keeps it
    // alive for this whole synchronous call, and the pointers are consumed by
    // `Pooling` below and never escape `embed`, so the borrow stays sound.
    var rows: [UnsafePointer<Float>] = []
    rows.reserveCapacity(ids.count)
    for id in ids {
      guard id >= 0, let row = matrix.row(forTokenId: UInt32(id)) else {
        throw .missingRow(tokenId: id)
      }
      rows.append(row)
    }
    var out = [Float](repeating: 0, count: dims)
    Pooling.meanPoolNormalized(rows: rows, dims: dims, into: &out)
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

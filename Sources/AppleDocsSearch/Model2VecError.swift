/// Typed error emitted while loading or decoding offline `model2vec` semantic embedding models.
public enum Model2VecError: Error, Hashable, Sendable {
    case invalidMagicOrVersion
    case truncatedMatrix(actual: Int, expected: Int)
    case unsupportedTokenizer(String)
    case missingONNXEmbeddingTensor
    case protobufFailure(String)
    case ioFailure(String)
}

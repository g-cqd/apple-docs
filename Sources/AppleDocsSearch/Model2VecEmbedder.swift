import AemiProtobuf
import AppleDocsKernels
import Foundation

/// Static `model2vec` embedding matrix loader & encoder supporting both:
/// - Compact `M2VQ8` quantized weight files (`model2vec.q8` shipped in snapshots), retained in memory in compact
///   `int8 + per-row scale` form (~31 MiB instead of ~124 MiB expanded float32) and dequantized per looked-up row
/// - Raw ONNX protobuf exports (`onnx/model.onnx`) decoded zero-copy via `g-cqd/AemiProtobuf`
///
/// Mean-pools token embedding rows in `Double` precision and L2-normalizes to unit length,
/// matching the Bun `model2vec-static.js` pipeline bit-for-bit.
public struct Model2VecEmbedder: Sendable {
    static let q8Magic: [UInt8] = Array("M2VQ8\0".utf8)
    static let q8HeaderBytes = 15
    static let onnxFloatDataType: Int64 = 1

    /// Decoded 2-D float32 embedding matrix (`rows * dims` elements).
    public struct EmbeddingMatrix: Hashable, Sendable {
        public let rows: Int
        public let dims: Int
        public let weights: [Float]

        public init(rows: Int, dims: Int, weights: [Float]) {
            self.rows = rows
            self.dims = dims
            self.weights = weights
        }
    }

    struct Q8Header: Sendable {
        let rows: Int
        let dims: Int
        let scales: [Float]
        let dataOffset: Int
    }

    enum Storage: Sendable {
        case float32(EmbeddingMatrix)
        case q8(Q8Header, bytes: [UInt8])
    }

    public let tokenizer: WordPieceTokenizer
    let storage: Storage

    /// Embedding vector dimensionality.
    public var dimensions: Int {
        switch storage {
            case .float32(let m): m.dims
            case .q8(let h, _): h.dims
        }
    }

    /// Row count of the vocabulary weight table.
    public var rows: Int {
        switch storage {
            case .float32(let m): m.rows
            case .q8(let h, _): h.rows
        }
    }

    /// Materializes an ``EmbeddingMatrix`` view (used by tests / ONNX round-trips).
    public var matrix: EmbeddingMatrix {
        switch storage {
            case .float32(let m):
                return m
            case .q8(_, let bytes):
                return (try? Self.parseQ8Matrix(bytes)) ?? EmbeddingMatrix(rows: 0, dims: 0, weights: [])
        }
    }

    /// Whether this instance stores its vocabulary in compact `int8 + scale` form rather than expanded `Float`.
    public var isCompactQ8: Bool {
        if case .q8 = storage { return true }
        return false
    }

    public init(tokenizer: WordPieceTokenizer, matrix: EmbeddingMatrix) {
        self.tokenizer = tokenizer
        self.storage = .float32(matrix)
    }

    /// Initializes directly over validated `M2VQ8` bytes without expanding the 4× float32 matrix.
    public init(tokenizer: WordPieceTokenizer, q8Bytes bytes: [UInt8]) throws(Model2VecError) {
        let header = try Self.validateQ8Header(bytes)
        self.tokenizer = tokenizer
        self.storage = .q8(header, bytes: bytes)
    }

    /// Loads `tokenizer.json` and prefers `model2vec.q8` (falling back to `onnx/model.onnx`) in `directory`.
    public init(modelDirectory directory: String) throws(Model2VecError) {
        let dirURL = URL(fileURLWithPath: directory, isDirectory: true)
        let tokenizerURL = dirURL.appendingPathComponent("tokenizer.json")
        let tokenizerBytes = try Self.readBytes(from: tokenizerURL)
        let tokenizer = try WordPieceTokenizer(tokenizerJSON: tokenizerBytes)

        let q8URL = dirURL.appendingPathComponent("model2vec.q8")
        if FileManager.default.fileExists(atPath: q8URL.path) {
            try self.init(tokenizer: tokenizer, q8Bytes: try Self.readBytes(from: q8URL))
        } else {
            let onnxURL = dirURL.appendingPathComponent("onnx/model.onnx")
            let matrix = try Self.extractONNXEmbeddingMatrix(Self.readBytes(from: onnxURL))
            self.init(tokenizer: tokenizer, matrix: matrix)
        }
    }

    /// Embeds `text` into a unit L2-normalized `Float` vector of length `dimensions`.
    public func embed(_ text: String) -> [Float] {
        var ids = tokenizer.encode(text)
        if ids.isEmpty { ids = [0] }
        let dims = dimensions
        let rowCount = rows
        guard dims > 0, rowCount > 0 else { return [] }

        switch storage {
            case .q8(let h, let bytes):
                return AppleDocsKernels.poolQ8AndNormalize(
                    tokenIDs: ids.map(Int32.init),
                    q8Bytes: bytes,
                    dataOffset: h.dataOffset,
                    scales: h.scales,
                    rows: h.rows,
                    dimensions: h.dims
                )
            case .float32(let m):
                var acc = [Double](repeating: 0, count: dims)
                for id in ids {
                    let row = (id >= 0 && id < rowCount) ? id : 0
                    let base = row * dims
                    for d in 0 ..< dims { acc[d] += Double(m.weights[base + d]) }
                }
                let inv = 1.0 / Double(ids.count)
                var vec = [Float](repeating: 0, count: dims)
                var normSq: Double = 0
                for d in 0 ..< dims {
                    vec[d] = Float(acc[d] * inv)
                    normSq += Double(vec[d]) * Double(vec[d])
                }
                let norm = normSq.squareRoot()
                if norm > 0 {
                    for d in 0 ..< dims { vec[d] = Float(Double(vec[d]) / norm) }
                }
                return vec
        }
    }
}

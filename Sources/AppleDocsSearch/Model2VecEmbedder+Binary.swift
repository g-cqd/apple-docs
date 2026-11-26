import AemiProtobuf
import Foundation

extension Model2VecEmbedder {
    /// Encodes an `EmbeddingMatrix` into the compact `M2VQ8` little-endian binary format.
    public static func quantizeQ8(_ matrix: EmbeddingMatrix) -> [UInt8] {
        let rows = matrix.rows
        let dims = matrix.dims
        var out = [UInt8](repeating: 0, count: q8HeaderBytes + rows * 4 + rows * dims)
        for idx in 0 ..< q8Magic.count { out[idx] = q8Magic[idx] }
        out[6] = 1
        writeUInt32LE(UInt32(rows), into: &out, at: 7)
        writeUInt32LE(UInt32(dims), into: &out, at: 11)

        for r in 0 ..< rows {
            let rowBase = r * dims
            var maxAbs: Float = 0
            for d in 0 ..< dims {
                let absVal = abs(matrix.weights[rowBase + d])
                if absVal > maxAbs { maxAbs = absVal }
            }
            let scale: Float = maxAbs > 0 ? (maxAbs / 127.0) : 1.0
            writeUInt32LE(scale.bitPattern, into: &out, at: q8HeaderBytes + r * 4)
            for d in 0 ..< dims {
                let scaled = (matrix.weights[rowBase + d] / scale).rounded()
                let clamped = max(-127, min(127, Int(scaled)))
                out[q8HeaderBytes + rows * 4 + rowBase + d] = UInt8(bitPattern: Int8(clamped))
            }
        }
        return out
    }

    /// Validates `M2VQ8` header + byte count and extracts per-row `Float` scales.
    static func validateQ8Header(_ bytes: [UInt8]) throws(Model2VecError) -> Q8Header {
        guard bytes.count >= q8HeaderBytes,
            Array(bytes[0 ..< 6]) == q8Magic,
            bytes[6] == 1
        else {
            throw .invalidMagicOrVersion
        }
        let rows = Int(readUInt32LE(bytes, at: 7))
        let dims = Int(readUInt32LE(bytes, at: 11))
        let expected = q8HeaderBytes + rows * 4 + rows * dims
        guard bytes.count == expected else {
            throw .truncatedMatrix(actual: bytes.count, expected: expected)
        }
        let scalesOff = q8HeaderBytes
        var scales = [Float](repeating: 0, count: rows)
        for r in 0 ..< rows {
            scales[r] = Float(bitPattern: readUInt32LE(bytes, at: scalesOff + r * 4))
        }
        return Q8Header(rows: rows, dims: dims, scales: scales, dataOffset: q8HeaderBytes + rows * 4)
    }

    /// Decodes `M2VQ8` bytes back into an `EmbeddingMatrix`.
    public static func parseQ8Matrix(_ bytes: [UInt8]) throws(Model2VecError) -> EmbeddingMatrix {
        let header = try validateQ8Header(bytes)
        var weights = [Float](repeating: 0, count: header.rows * header.dims)
        for r in 0 ..< header.rows {
            let scale = header.scales[r]
            let rowBase = r * header.dims
            for d in 0 ..< header.dims {
                let q = Int8(bitPattern: bytes[header.dataOffset + rowBase + d])
                weights[rowBase + d] = Float(q) * scale
            }
        }
        return EmbeddingMatrix(rows: header.rows, dims: header.dims, weights: weights)
    }

    /// Extracts the 2-D float32 embedding initializer tensor from an ONNX `ModelProto` using
    /// `g-cqd/AemiProtobuf`'s bounds-checked `WireReader`.
    public static func extractONNXEmbeddingMatrix(_ bytes: [UInt8]) throws(Model2VecError) -> EmbeddingMatrix {
        let limits = WireLimits(maxDepth: 32, maxMessageBytes: max(bytes.count, 268_435_456))
        let found: EmbeddingMatrix?
        do {
            found = try WireReader.withReader(over: bytes, limits: limits) { reader throws(WireError) in
                try Self.firstNestedMessage(in: &reader, fieldNumber: 7) { graphReader throws(WireError) in
                    try Self.firstNestedMessage(in: &graphReader, fieldNumber: 5, parse: Self.readTensorProto)
                }
            }
        } catch {
            throw .protobufFailure(String(describing: error))
        }
        guard let matrix = found else { throw .missingONNXEmbeddingTensor }
        return matrix
    }

    private static func firstNestedMessage<T>(
        in reader: inout WireReader,
        fieldNumber: UInt32,
        parse: (inout WireReader) throws(WireError) -> T?
    ) throws(WireError) -> T? {
        while let tag = try reader.nextTag() {
            if tag.fieldNumber.rawValue == fieldNumber, tag.wireType == .lengthDelimited {
                if let value = try reader.readMessage(parse) {
                    return value
                }
            } else {
                try reader.skipField(tag)
            }
        }
        return nil
    }

    private static func readTensorProto(_ reader: inout WireReader) throws(WireError) -> EmbeddingMatrix? {
        var dims: [Int] = []
        var dataType: Int64?
        var rawData: [UInt8]?

        while let tag = try reader.nextTag() {
            switch (tag.fieldNumber.rawValue, tag.wireType) {
                case (1, .varint):
                    dims.append(Int(try reader.readVarint()))
                case (1, .lengthDelimited):
                    dims.append(contentsOf: try reader.readPackedVarints(Int64.self).map(Int.init))
                case (2, .varint):
                    dataType = Int64(bitPattern: try reader.readVarint())
                case (9, .lengthDelimited):
                    rawData = try reader.readBytes()
                default:
                    try reader.skipField(tag)
            }
        }
        guard dataType == onnxFloatDataType, dims.count == 2, let rawData else { return nil }
        let rows = dims[0]
        let cols = dims[1]
        guard rows > 0, cols > 0, rawData.count == rows * cols * 4 else { return nil }

        var weights = [Float](repeating: 0, count: rows * cols)
        for idx in 0 ..< (rows * cols) {
            weights[idx] = Float(bitPattern: readUInt32LE(rawData, at: idx * 4))
        }
        return EmbeddingMatrix(rows: rows, dims: cols, weights: weights)
    }

    static func readBytes(from url: URL) throws(Model2VecError) -> [UInt8] {
        do {
            return Array(try Data(contentsOf: url))
        } catch {
            throw .ioFailure("Unable to read \(url.path): \(error)")
        }
    }

    static func readUInt32LE(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        UInt32(bytes[offset])
            | (UInt32(bytes[offset + 1]) << 8)
            | (UInt32(bytes[offset + 2]) << 16)
            | (UInt32(bytes[offset + 3]) << 24)
    }

    static func writeUInt32LE(_ value: UInt32, into bytes: inout [UInt8], at offset: Int) {
        bytes[offset] = UInt8(truncatingIfNeeded: value)
        bytes[offset + 1] = UInt8(truncatingIfNeeded: value >> 8)
        bytes[offset + 2] = UInt8(truncatingIfNeeded: value >> 16)
        bytes[offset + 3] = UInt8(truncatingIfNeeded: value >> 24)
    }
}

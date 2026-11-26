/// Bun's stored vector encodings (`search/embedding.js`): packed sign bits (`quantizeTo`) for the Hamming
/// shortlist and int8 with a trailing little-endian float32 scale (`quantizeI8`) for rescoring.
public enum EmbeddingQuantizer {
    /// Bit `i` set when component `i` is `>= 0`.
    public static func signBits(_ vector: [Float]) -> [UInt8] {
        SemanticCandidates.quantize(vector, dimensions: vector.count)
    }

    /// Components scaled by `127 / max|v|` and rounded like `Math.round` (half up), then the float32 scale
    /// `max|v| / 127` (1 for a zero vector).
    public static func int8(_ vector: [Float]) -> [UInt8] {
        let amax = vector.reduce(0.0) { max($0, abs(Double($1))) }
        let scale = amax > 0 ? amax / 127 : 1
        let inverse = amax > 0 ? 127 / amax : 0
        var out: [UInt8] = []
        out.reserveCapacity(vector.count + 4)
        for component in vector {
            // `Math.round`: halves toward +infinity, computed without the `x + 0.5` rounding error.
            let scaled = Double(component) * inverse
            let floor = scaled.rounded(.down)
            let rounded = scaled - floor >= 0.5 ? floor + 1 : floor
            out.append(UInt8(bitPattern: Int8(min(127, max(-127, rounded)))))
        }
        withUnsafeBytes(of: Float(scale).bitPattern.littleEndian) { out.append(contentsOf: $0) }
        return out
    }
}

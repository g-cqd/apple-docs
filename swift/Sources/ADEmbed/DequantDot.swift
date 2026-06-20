// The int8 rescore dot product — the inverse of `Quantize.i8Code`. Dequantizes a
// packed `[int8 × dims][f32 LE absmax/127 scale]` record and dots it with the fp32
// query: `scale · Σ q[i]·i8[i]`. For a fixed query this ranks identically to cosine
// (the query norm is constant across the shortlist). Bit-exact with the JS `dotI8`
// (apple-docs src/search/embedding.js).
//
// FLOAT DETERMINISM (the parity contract): the JS accumulates the dot in an f64.
// `Double(q[i])` and `Double(i8[i])` are exact f32→f64 / int8→f64 promotions, so the
// products and the running sum match the JS bit-for-bit, as does the final
// `dot * Double(scale)`. The trailing f32 scale is read little-endian through
// `ADFCore.Endian` (`loadLE32` → `Float(bitPattern:)`), never hand-assembled.

private import ADFCore

extension Quantize {
    /// `scale · Σ q[i]·i8[i]` over `dims` signed bytes, with the trailing
    /// little-endian f32 scale at byte offset `dims`. `i8` must hold exactly
    /// `dims + 4` bytes (the caller's `i8.count == dims + 4` guard, the JS
    /// `i8.length === store.dims + 4`). Accumulates in `Double`.
    public static func dequantDot(q: [Float], i8: [UInt8], dims: Int) -> Double {
        var dot = 0.0
        for i in 0 ..< dims {
            let signed = Int8(bitPattern: i8[i])
            dot += Double(q[i]) * Double(signed)
        }
        let scaleBits = i8.withUnsafeBytes { $0.loadLE32(dims) }
        let scale = Float(bitPattern: scaleBits)
        return dot * Double(scale)
    }
}

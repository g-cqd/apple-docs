// The int8 rescore dot product — the bit-exact port of `dotI8` in the JS
// reference (apple-docs src/search/embedding.js).
//
// Layout of one packed record: `[int8 × dims][f32 LE absmax/127 scale]` =
// `dims + 4` bytes. The result is `scale · Σ q[i]·i8[i]`, which ranks
// identically to cosine for a fixed query (the query norm is constant across
// the shortlist).
//
// FLOAT DETERMINISM (the parity contract): the JS accumulates the dot in a
// JS number (f64). We accumulate in `Double` too — `Double(qFp32[i])` and
// `Double(i8[i])` are exact f32→f64 / int8→f64 promotions, so the products and
// the running sum match the JS bit-for-bit; the final `dot * Double(scale)`
// likewise. The trailing f32 scale is read little-endian through
// `ADFCore.Endian` (`loadLE32` → `Float(bitPattern:)`), never hand-assembled.

private import ADFCore

enum DotI8 {
    /// `scale · Σ qFp32[i]·i8[i]` over `dims` signed bytes at `off`, with the
    /// trailing little-endian f32 scale at `off + dims`. `packed` must hold at
    /// least `off + dims + 4` bytes (the caller checks `i8.count == dims + 4`,
    /// the JS `i8.length === store.dims + 4` guard). Accumulates in `Double`.
    static func dot(_ qFp32: [Float], _ packed: [UInt8], off: Int, dims: Int) -> Double {
        var dot = 0.0
        for i in 0 ..< dims {
            let signed = Int8(bitPattern: packed[off + i])
            dot += Double(qFp32[i]) * Double(signed)
        }
        let scaleBits = packed.withUnsafeBytes { $0.loadLE32(off + dims) }
        let scale = Float(bitPattern: scaleBits)
        return dot * Double(scale)
    }
}

// Storage quantizers. Bit-exact for comparisons, clamps and one f64→f32
// store — no float summation anywhere.

import ADFCore

public enum Quantize {
    /// Sign code: bit i set iff vec[i] >= 0, LSB-first within each byte.
    /// -0.0 sets the bit (-0.0 >= 0 in both Swift and JS); NaN does not
    /// (NaN >= 0 is false in both).
    public static func signCode(_ vec: [Float]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: (vec.count + 7) / 8)
        for i in 0 ..< vec.count where vec[i] >= 0 {
            out[i >> 3] |= 1 << (i & 7)
        }
        return out
    }

    /// Int8+scale code: `[int8 × dims][f32 LE absmax/127 scale]`. All
    /// intermediates in f64; rounding is half away from zero (standard
    /// quantizer semantics); clamp ±127; NaN components store 0.
    public static func i8Code(_ vec: [Float]) -> [UInt8] {
        let n = vec.count
        var out = [UInt8](repeating: 0, count: n + 4)
        var amax: Double = 0
        for v in vec {
            let a = abs(Double(v))
            if a > amax { amax = a }
        }
        let scale = amax > 0 ? amax / 127 : 1.0
        let inv = amax > 0 ? 127 / amax : 0.0
        for i in 0 ..< n {
            var q = (Double(vec[i]) * inv).rounded(.toNearestOrAwayFromZero)
            if q > 127 { q = 127 } else if q < -127 { q = -127 }
            out[i] = q.isNaN ? 0 : UInt8(bitPattern: Int8(q))
        }
        // The f32 absmax/127 scale trails the int8 codes as 4 little-endian bytes (the shared
        // `ADFCore` store, replacing the hand-rolled per-shift writes — byte-identical, one unaligned
        // store). `out` is uniquely owned here, so this stays copy-free.
        out.withUnsafeMutableBytes { $0.storeLE32(Float(scale).bitPattern, at: n) }
        return out
    }
}

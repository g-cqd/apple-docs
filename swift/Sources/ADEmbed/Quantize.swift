// Storage quantizers mirrored from src/search/embedding.js (normative).
// Both are bit-exact gates: comparisons, clamps and one f64→f32 store —
// no float summation anywhere.

public enum Quantize {
  /// Sign code (quantizeTo, embedding.js:37): bit i set iff vec[i] >= 0,
  /// LSB-first within each byte. -0.0 sets the bit (-0.0 >= 0 in both
  /// languages); NaN does not (NaN >= 0 is false in both).
  public static func signCode(_ vec: [Float]) -> [UInt8] {
    var out = [UInt8](repeating: 0, count: (vec.count + 7) / 8)
    for i in 0..<vec.count where vec[i] >= 0 {
      out[i >> 3] |= 1 << (i & 7)
    }
    return out
  }

  /// Int8+scale code (quantizeI8, embedding.js:81): `[int8 × dims][f32 LE
  /// absmax/127 scale]`. All intermediates in f64 like JS; rounding is JS
  /// Math.round (half toward +∞, no x+0.5 double-rounding artifact);
  /// clamp ±127; NaN components store 0 (JS Int8Array conversion).
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
    for i in 0..<n {
      var q = jsRound(Double(vec[i]) * inv)
      if q > 127 { q = 127 } else if q < -127 { q = -127 }
      out[i] = q.isNaN ? 0 : UInt8(bitPattern: Int8(q))
    }
    let scaleBits = Float(scale).bitPattern
    out[n] = UInt8(truncatingIfNeeded: scaleBits)
    out[n + 1] = UInt8(truncatingIfNeeded: scaleBits >> 8)
    out[n + 2] = UInt8(truncatingIfNeeded: scaleBits >> 16)
    out[n + 3] = UInt8(truncatingIfNeeded: scaleBits >> 24)
    return out
  }

  /// ECMA-262 Math.round: nearest integer, exact halves toward +∞. Computed
  /// via floor + exact fractional compare — floor(x + 0.5) would
  /// double-round (e.g. 0.49999999999999994 → 1, where JS yields 0).
  static func jsRound(_ x: Double) -> Double {
    let floor = x.rounded(.down)
    let fraction = x - floor // exact: floor differs from x by < 1
    if fraction.isNaN { return x } // x was NaN or ±infinity
    return fraction >= 0.5 ? floor + 1 : floor
  }
}

// Bag pooling mirrored BIT-FOR-BIT from the potion ONNX graph (probed):
// per-dim f32 sequential accumulation over rows in bag order, f32 divide by
// Float(count), then L2 normalize as a single sequential f32 sum-of-squares
// chain, f32 sqrt (IEEE-correctly-rounded), f32 divide.
//
// Parity contract: the per-dim accumulation chains are independent, so
// vectorizing ACROSS dims is allowed; the norm reduction is ONE chain and
// must stay sequential (no tree/SIMD reduction — Swift never reassociates
// float math, so a plain loop is exact). f64 accumulation was measured
// ~1.5e-8 off the runtime — do not "improve" precision here.

public enum Pooling {
  /// `out` = L2-normalized mean of `rows` (each `dims` floats), bit-exact
  /// against the onnxruntime reference. `rows` must be non-empty (the
  /// embedder pads empty token lists with the [PAD] row first).
  public static func meanPoolNormalized(rows: [UnsafePointer<Float>], dims: Int, into out: inout [Float]) {
    precondition(!rows.isEmpty, "meanPoolNormalized requires at least one row")
    precondition(out.count == dims, "output width mismatch")
    for i in 0..<dims { out[i] = 0 }
    for row in rows {
      for i in 0..<dims { out[i] += row[i] }
    }
    let count = Float(rows.count)
    for i in 0..<dims { out[i] /= count }
    var sumSquares: Float = 0
    for i in 0..<dims { sumSquares += out[i] * out[i] }
    let norm = sumSquares.squareRoot()
    for i in 0..<dims { out[i] /= norm }
  }
}

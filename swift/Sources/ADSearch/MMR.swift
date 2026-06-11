// Maximal Marginal Relevance, mirrored bit-for-bit from `mmrSelect`
// (src/search/fusion.js:97-129) with the production similarity baked in:
// 1 - hamming(a, b) / (dim * 8) over equal-length byte vectors — the only
// sim the JS call site uses (fuse-semantic.js:87-90). Scalar arithmetic
// only; see Fusion.swift for the parity rationale.

public enum MMR {
  /// Returns the full output permutation (selected window, then the
  /// untouched tail in incoming order), as indices into the input order.
  ///
  /// - vectors: `n` rows of `dim` bytes (rows whose presence bit is 0 are
  ///   ignored; their contents are arbitrary).
  /// - presence: LSB-first bitmap, bit `i` = item `i` has a vector.
  /// - limit: 0 means uncapped (JS `limit ?? n`); the shim never encodes a
  ///   caller-supplied limit < 1.
  public static func select(
    n: Int,
    dim: Int,
    vectors: UnsafeRawBufferPointer,
    presence: UnsafeRawBufferPointer,
    lambda: Double,
    limit: Int
  ) -> [UInt32] {
    if n <= 2 { return (0..<n).map(UInt32.init) }
    let cap = min(limit > 0 ? limit : n, n)
    var rel = [Double](repeating: 0, count: n)
    for i in 0..<n { rel[i] = Double(n - i) / Double(n) }

    func present(_ i: Int) -> Bool {
      (presence[i >> 3] >> (i & 7)) & 1 == 1
    }
    func similarity(_ a: Int, _ b: Int) -> Double {
      let base = vectors.baseAddress!
      var d = 0
      for i in 0..<dim {
        let x = base.load(fromByteOffset: a * dim + i, as: UInt8.self)
        let y = base.load(fromByteOffset: b * dim + i, as: UInt8.self)
        d += (x ^ y).nonzeroBitCount
      }
      return 1 - Double(d) / Double(dim * 8)
    }

    var remaining = Array(1..<n)
    var selected: [Int] = [0]
    while selected.count < cap && !remaining.isEmpty {
      var bestPos = 0
      var bestScore = -Double.infinity
      for p in 0..<remaining.count {
        let i = remaining[p]
        var maxSim = 0.0
        if present(i) {
          for j in selected where present(j) {
            let s = similarity(i, j)
            if s > maxSim { maxSim = s }
          }
        }
        let mmr = lambda * rel[i] - (1 - lambda) * maxSim
        if mmr > bestScore {
          bestScore = mmr
          bestPos = p
        }
      }
      selected.append(remaining.remove(at: bestPos))
    }
    var out = selected
    out.append(contentsOf: remaining)
    return out.map(UInt32.init)
  }
}

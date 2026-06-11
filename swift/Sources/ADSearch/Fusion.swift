// Fusion math mirrored bit-for-bit from src/search/fusion.js (normative).
//
// Parity contract: accumulation order is outer-lists-then-inner-ranks; every
// expression keeps the JS source's left-associative scalar shape. No FMA, no
// SIMD/vDSP reductions — both reorder or fuse the non-associative double
// operations and break Object.is parity with the JS implementation.

public enum Fusion {
  /// One ranked list. `ranked` holds indices into the caller's interned id
  /// table (the JS shim interns ids first-seen, which reproduces the JS
  /// Map insertion order). `scores`, when present, is aligned 1:1 with
  /// `ranked` — the shim only takes the native path when that holds.
  public struct List: Sendable {
    public let ranked: [UInt32]
    public let weight: Double
    public let scores: [Double]?

    public init(ranked: [UInt32], weight: Double, scores: [Double]? = nil) {
      self.ranked = ranked
      self.weight = weight
      self.scores = scores
    }
  }

  /// Mirror of `weightedRRF` (fusion.js:22-31). Caller guarantees every
  /// index < idCount (validated at the FFI boundary).
  public static func weightedRRF(_ lists: [List], idCount: Int, k: Double = 60) -> [Double] {
    var fused = [Double](repeating: 0, count: idCount)
    for list in lists {
      for i in 0..<list.ranked.count {
        fused[Int(list.ranked[i])] += list.weight / (k + Double(i) + 1)
      }
    }
    return fused
  }

  /// Mirror of `hybridFusion` (fusion.js:66-78).
  public static func hybrid(_ lists: [List], idCount: Int, k: Double = 60, beta: Double = 0.5) -> [Double] {
    var fused = [Double](repeating: 0, count: idCount)
    for list in lists {
      let norm = list.scores.map(normalize)
      for i in 0..<list.ranked.count {
        var add = list.weight / (k + Double(i) + 1)
        if let norm { add += beta * list.weight * norm[i] }
        fused[Int(list.ranked[i])] += add
      }
    }
    return fused
  }

  /// Mirror of `normalizeScores` (fusion.js:41-53): strict comparisons, so a
  /// degenerate or NaN range maps everything to 0 exactly like the JS guard.
  static func normalize(_ scores: [Double]) -> [Double] {
    var minV = Double.infinity
    var maxV = -Double.infinity
    for v in scores {
      if v < minV { minV = v }
      if v > maxV { maxV = v }
    }
    let range = maxV - minV
    guard range > 0 else { return [Double](repeating: 0, count: scores.count) }
    return scores.map { ($0 - minV) / range }
  }
}

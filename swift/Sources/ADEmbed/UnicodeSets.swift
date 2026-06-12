// Binary-search lookups over the engine-derived tables in
// GeneratedUnicodeTables.swift (flat inclusive [lo, hi] pairs, ascending).
//
// The tables are generated from the same JavaScriptCore engine that produces
// the parity fixtures (scripts/gen-unicode-tables.mjs), so every character
// class decision here matches transformers.js by construction.

public enum UnicodeSets {
  static func contains(_ ranges: [UInt32], _ value: UInt32) -> Bool {
    // Bounds bail: ASCII/Latin scalars dominate real corpora and sit below
    // every CJK/mark range — one compare instead of a full search. (The v2
    // astral ranges deepened the chineseChar search; this more than pays
    // that back.)
    if value < ranges[0] || value > ranges[ranges.count - 1] { return false }
    var lo = 0
    var hi = ranges.count / 2 - 1
    while lo <= hi {
      let mid = (lo + hi) / 2
      if value < ranges[mid * 2] {
        hi = mid - 1
      } else if value > ranges[mid * 2 + 1] {
        lo = mid + 1
      } else {
        return true
      }
    }
    return false
  }

  static func isCleanTextRemoved(_ v: UInt32) -> Bool { contains(UnicodeTables.cleanTextRemoval, v) }
  public static func isJsWhitespace(_ v: UInt32) -> Bool { contains(UnicodeTables.jsWhitespace, v) }
  static func isNonspacingMark(_ v: UInt32) -> Bool { contains(UnicodeTables.nonspacingMark, v) }
  static func isBertPunctuation(_ v: UInt32) -> Bool { contains(UnicodeTables.bertPunctuation, v) }
  static func isChinese(_ v: UInt32) -> Bool { contains(UnicodeTables.chineseChar, v) }

  /// Canonical decomposition payload for `v`, or nil when `v` decomposes to
  /// itself. Hangul syllables are absent by design — NFD.swift derives them
  /// arithmetically.
  static func nfdDecomposition(of v: UInt32) -> ArraySlice<UInt32>? {
    let index = UnicodeTables.nfdIndex
    var lo = 0
    var hi = index.count - 1
    while lo <= hi {
      let mid = (lo + hi) / 2
      if index[mid] < v {
        lo = mid + 1
      } else if index[mid] > v {
        hi = mid - 1
      } else {
        return UnicodeTables.nfdPayload[Int(UnicodeTables.nfdOffsets[mid])..<Int(UnicodeTables.nfdOffsets[mid + 1])]
      }
    }
    return nil
  }
}

// Fuzzy title matching — byte-exact port of the JS fuzzy module. Levenshtein
// (early-exit, over UTF-16 code units to match JS string indexing) over a
// trigram-OR bm25 candidate pre-filter; sorted by distance (stable, preserving
// candidate order for ties). framework/kind are deliberately ignored here —
// filtering happens later on the records.

import ADContent
import ADStorage
import Algorithms

enum Fuzzy {
  /// Levenshtein edit distance with early exit (returns maxDist+1 when exceeded).
  static func levenshtein(_ a: [UInt16], _ b: [UInt16], maxDist: Int = 2) -> Int {
    let m = a.count
    let n = b.count
    if abs(m - n) > maxDist { return maxDist + 1 }
    if m == 0 { return n }
    if n == 0 { return m }
    var prev = Array(0...n)
    var curr = [Int](repeating: 0, count: n + 1)
    for i in 1...m {
      curr[0] = i
      var rowMin = i
      for j in 1...n {
        curr[j] =
          a[i - 1] == b[j - 1]
          ? prev[j - 1]
          : 1 + Swift.min(prev[j], curr[j - 1], prev[j - 1])
        if curr[j] < rowMin { rowMin = curr[j] }
      }
      if rowMin > maxDist { return maxDist + 1 }
      swap(&prev, &curr)
    }
    return prev[n]
  }

  /// Character trigrams of `JsString.lowercase(s)` over UTF-16 units, dedup'd
  /// (the OR query is order-insensitive, so first-occurrence order is fine).
  static func trigrams(_ s: String) -> [String] {
    let lower = Array(JsString.lowercase(s).utf16)
    guard lower.count >= 3 else { return [] }
    var seen = Set<String>()
    var out: [String] = []
    for i in 0...(lower.count - 3) {
      let tri = String(decoding: lower[i..<(i + 3)], as: UTF16.self)
      if seen.insert(tri).inserted { out.append(tri) }
    }
    return out
  }

  /// FTS5 OR-of-trigrams MATCH expression; each trigram double-quoted (with `"`
  /// escaped) to disable FTS5 syntax.
  static func buildTrigramOrQuery(_ tris: [String]) -> String? {
    guard !tris.isEmpty else { return nil }
    return tris.map { "\"\(escapeFtsQuotes($0))\"" }.joined(separator: " OR ")
  }

  /// fuzzyMatchTitles(query, db, {limit, maxDist}): candidate ids in
  /// distance-then-candidate order, sliced to `limit`.
  static func matchTitles(_ conn: StorageConnection, query: String, limit: Int, maxDist: Int = 2)
    -> [Int64]
  {
    let tris = trigrams(query)
    guard tris.count >= 2, let orQuery = buildTrigramOrQuery(tris) else { return [] }
    let sqlLimit = max(limit * 5, 100)
    let candidates = conn.fuzzyTrigramCandidates(orQuery, limit: sqlLimit)
    let queryLower = Array(JsString.lowercase(query).utf16)

    var matches: [(id: Int64, distance: Int, orig: Int)] = []
    for (orig, candidate) in candidates.enumerated() {
      let loweredTitle = JsString.lowercase(candidate.title)
      // Length prefilter (same lowercased UTF-16 length levenshtein's early exit
      // uses) before the [UInt16] alloc — a length gap > maxDist can't be closed
      // by ≤ maxDist edits, so the candidate would be dropped anyway.
      if abs(loweredTitle.utf16.count - queryLower.count) > maxDist { continue }
      let titleLower = Array(loweredTitle.utf16)
      let distance = levenshtein(queryLower, titleLower, maxDist: maxDist)
      if distance <= maxDist { matches.append((candidate.id, distance, orig)) }
    }
    // Bounded top-K by distance (JS Array.sort, stable) — preserve candidate
    // (bm25) order for ties via the original index. The comparator is a strict
    // total order (`orig` is unique), so this is identical to `sort().prefix(limit)`.
    return matches.min(count: limit) {
      $0.distance != $1.distance ? $0.distance < $1.distance : $0.orig < $1.orig
    }.map(\.id)
  }
}

// Fuzzy title matching — byte-exact port of the JS fuzzy module. Levenshtein
// (early-exit, over UTF-16 code units to match JS string indexing) over a
// trigram-OR bm25 candidate pre-filter; sorted by distance (stable, preserving
// candidate order for ties). framework/kind are deliberately ignored here —
// filtering happens later on the records.

import ADContent
import ADFText
import ADStorage
import Algorithms

enum Fuzzy {

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
      let distance = ADFText.editDistance(queryLower, titleLower, maxDistance: maxDist)
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

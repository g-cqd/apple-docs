// Byte-exact port of the JS FTS query builder. The FTS5 MATCH string MUST be
// identical to the JS output — a different MATCH expression returns different
// rows. JS `Set` preserves INSERTION order, so the term dedup uses an
// `OrderedSet` (insertion-ordered), not a Swift `Set`.

import OrderedCollections

enum FtsQuery {
  /// Generous ceiling on whitespace-separated tokens in a passthrough boolean
  /// expression — far above any realistic query, but bounds the CPU a valid-yet-
  /// pathological AND/OR/NOT expression can spend in the FTS5 matcher.
  private static let maxPassthroughTerms = 128

  /// buildFtsQuery(q) — the FTS5 MATCH expression.
  static func build(_ q: String) -> String {
    // Escape hatch: an FTS5 operator word or a double quote → passthrough,
    // unless the expression is pathologically large, in which case collapse it
    // to a single quoted phrase (a cheap MATCH) rather than passing it through.
    if q.contains(#/\b(AND|OR|NOT)\b/#) || q.contains("\"") {
      if passthroughTooComplex(q) { return "\"" + escapeFtsQuotes(q) + "\"" }
      return q
    }
    let words = trimWS(q).split(whereSeparator: { $0.isWhitespace })
    let groups = words.compactMap { buildWordGroup(String($0)) }
    if groups.isEmpty { return "\"\"" }
    return groups.joined(separator: " ")
  }

  /// sanitizeTrigramQuery(q) — the trigram-table MATCH expression.
  static func trigram(_ q: String) -> String {
    let trimmed = trimWS(q)
    if trimmed.isEmpty { return "\"\"" }
    if trimmed.wholeMatch(of: #/[A-Za-z0-9_\s]+/#) != nil { return trimmed }
    return "\"" + escapeFtsQuotes(trimmed) + "\""
  }

  /// True once the passthrough expression exceeds `maxPassthroughTerms`
  /// whitespace-separated tokens (counted lazily, bailing at the ceiling).
  private static func passthroughTooComplex(_ q: String) -> Bool {
    var tokens = 0
    for _ in q.split(whereSeparator: { $0.isWhitespace }) {
      tokens += 1
      if tokens > maxPassthroughTerms { return true }
    }
    return false
  }

  private static func buildWordGroup(_ word: String) -> String? {
    let segments = word.split(separator: #/[._:/\\]+/#).map(String.init).filter { !$0.isEmpty }
    if segments.isEmpty { return nil }

    var prefixTerms = OrderedSet<String>()
    var exactTerms = OrderedSet<String>()
    for seg in segments {
      prefixTerms.append(seg.lowercased())
      for sub in camelSubwords(seg) { exactTerms.append(sub.lowercased()) }
    }
    if segments.count > 1 { prefixTerms.append(segments.joined().lowercased()) }
    let exactOnly = exactTerms.subtracting(prefixTerms)

    var alternatives: [String] = prefixTerms.map { "\"\($0)\"*" }
    alternatives.append(contentsOf: exactOnly.map { "\"\($0)\"" })
    if alternatives.isEmpty { return nil }
    if alternatives.count == 1 { return alternatives[0] }
    return "(" + alternatives.joined(separator: " OR ") + ")"
  }

  /// camelSubwords(s) — split CamelCase into sub-words (empty if it doesn't split).
  private static func camelSubwords(_ s: String) -> [String] {
    let spaced = s.replacing(#/([a-z0-9])([A-Z])/#) { "\($0.output.1) \($0.output.2)" }
    let parts = spaced.split(separator: " ").map(String.init).filter { !$0.isEmpty }
    return parts.count > 1 ? parts : []
  }
}

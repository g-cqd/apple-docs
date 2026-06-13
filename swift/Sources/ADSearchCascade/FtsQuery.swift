// Byte-exact port of src/search/fts-query-builder.js. The FTS5 MATCH string
// MUST be identical to the JS output — a different MATCH expression returns
// different rows. JS `Set` preserves INSERTION order, so the term dedup here
// uses an insertion-ordered helper, not a Swift Set.

/// Insertion-ordered string dedup (mirrors JS `new Set()` iteration order).
private struct OrderedStrings {
  private(set) var items: [String] = []
  private var seen: Set<String> = []
  mutating func add(_ s: String) {
    if seen.insert(s).inserted { items.append(s) }
  }
  mutating func remove(_ s: String) {
    if seen.remove(s) != nil { items.removeAll { $0 == s } }
  }
}

enum FtsQuery {
  /// buildFtsQuery(q) — the FTS5 MATCH expression.
  static func build(_ q: String) -> String {
    // Escape hatch: an FTS5 operator word or a double quote → passthrough.
    if q.contains(#/\b(AND|OR|NOT)\b/#) || q.contains("\"") { return q }
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

  private static func buildWordGroup(_ word: String) -> String? {
    let segments = word.split(separator: #/[._:/\\]+/#).map(String.init).filter { !$0.isEmpty }
    if segments.isEmpty { return nil }

    var prefixTerms = OrderedStrings()
    var exactTerms = OrderedStrings()
    for seg in segments {
      prefixTerms.add(seg.lowercased())
      for sub in camelSubwords(seg) { exactTerms.add(sub.lowercased()) }
    }
    if segments.count > 1 { prefixTerms.add(segments.joined().lowercased()) }
    for t in prefixTerms.items { exactTerms.remove(t) }

    var alternatives: [String] = prefixTerms.items.map { "\"\($0)\"*" }
    alternatives.append(contentsOf: exactTerms.items.map { "\"\($0)\"" })
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

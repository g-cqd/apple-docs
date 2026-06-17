// Storage queries for the fuzzy tier: fuzzyTrigramCandidates (the
// OR-of-trigrams bm25 pre-filter) + getSearchRecordsByIds (the by-id record
// fetch). The records SELECT uses `resultColumns` ORDER so `SearchRow.decode`
// aligns.

extension StorageConnection {
  /// OR-of-trigrams candidate pre-filter: titles ranked by trigram-overlap
  /// bm25. [] when documents_trigram is absent.
  public func fuzzyTrigramCandidates(_ orQuery: String, limit: Int) -> [(id: Int64, title: String)] {
    guard conn.hasTrigram else { return [] }
    let sql = """
      SELECT d.id, d.title
      FROM documents_trigram
      JOIN documents d ON documents_trigram.rowid = d.id
      WHERE documents_trigram MATCH ?
      ORDER BY bm25(documents_trigram)
      LIMIT ?
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    stmt.bindText(1, orQuery)
    stmt.bindInt64(2, Int64(limit))
    var out: [(Int64, String)] = []
    while stmt.step() == SQLite.row {
      guard let title = stmt.text(1) else { continue }
      out.append((stmt.int(0) ?? 0, title))
    }
    return out
  }

  /// Framework synonyms: aliases of a canonical + canonicals of an alias.
  /// [] when the table is absent (prepareUncached nil).
  public func getFrameworkSynonyms(_ slug: String) -> [String] {
    let sql = """
      SELECT alias FROM framework_synonyms WHERE canonical = ?
      UNION
      SELECT canonical FROM framework_synonyms WHERE alias = ?
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    stmt.bindText(1, slug)
    stmt.bindText(2, slug)
    var out: [String] = []
    while stmt.step() == SQLite.row {
      if let value = stmt.text(0) { out.append(value) }
    }
    return out
  }

  /// Batched full records by document id, keyed by id. Decoded as SearchRow
  /// (the trailing `d.id` is read separately; the row decoder reads
  /// RESULT_COLUMNS only).
  public func searchRecordsByIds(_ ids: [Int64]) -> [Int64: SearchRow] {
    guard !ids.isEmpty else { return [:] }
    let sql =
      "SELECT \(resultColumns), d.id FROM documents d LEFT JOIN roots r ON r.slug = d.framework WHERE d.id IN (\(placeholders(ids.count)))"
    guard let stmt = conn.prepareUncached(sql) else { return [:] }
    for (i, id) in ids.enumerated() { stmt.bindInt64(Int32(i + 1), id) }
    var out: [Int64: SearchRow] = [:]
    while stmt.step() == SQLite.row {
      out[stmt.int(22) ?? 0] = SearchRow.decode(stmt, hasRankTier: false)
    }
    return out
  }
}

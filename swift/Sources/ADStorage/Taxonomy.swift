// Taxonomy facet counts for the MCP list_taxonomy tool (RFC 0005 Phase C). Ports
// src/commands/taxonomy.js: distinct values per column with counts, top-N by count.
// The column is a FIXED enum (interpolated into SQL) — never user input.

public struct TaxonomyCount: Sendable {
  public let value: String
  public let count: Int64
}

/// The taxonomy columns. `docKind` is the app's alias for the `kind` column (JS runs
/// the same query for both). A fixed whitelist so the interpolated column is safe.
public enum TaxonomyColumn: String, Sendable {
  case kind
  case role
  case roleHeading = "role_heading"
  case sourceType = "source_type"
}

extension StorageConnection {
  /// `SELECT COALESCE(<col>,'') value, COUNT(*) count FROM documents WHERE <col> IS NOT
  /// NULL AND <col> != '' GROUP BY <col> ORDER BY count DESC, value ASC [LIMIT n]`.
  /// `limit` nil = the full distribution (`all: true`). Mirrors the JS try/catch → [].
  public func taxonomyCounts(column: TaxonomyColumn, limit: Int?) -> [TaxonomyCount] {
    let col = column.rawValue
    let limitClause = limit.map { " LIMIT \($0)" } ?? ""
    let sql = """
      SELECT COALESCE(\(col), '') AS value, COUNT(*) AS count FROM documents
      WHERE \(col) IS NOT NULL AND \(col) != '' GROUP BY \(col) ORDER BY count DESC, value ASC\(limitClause)
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    var out: [TaxonomyCount] = []
    while true {
      let rc = stmt.step()
      if rc == SQLite.done { break }
      guard rc == SQLite.row else { return [] }
      out.append(TaxonomyCount(value: stmt.text(0) ?? "", count: stmt.int(1) ?? 0))
    }
    return out
  }
}

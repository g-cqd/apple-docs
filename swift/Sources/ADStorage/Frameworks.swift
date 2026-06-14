// Documentation roots for the MCP list_frameworks tool (RFC 0005 Phase C). Ports
// src/commands/frameworks.js: roots joined to their live (active) page counts, only
// those with at least one active page (zero-page catalog artifacts are noise). The
// projection keeps slug/name/kind/pageCount (status + last_seen are dropped).

public struct FrameworkRoot: Sendable {
  public let slug: String
  public let name: String
  public let kind: String
  public let pageCount: Int64
}

extension StorageConnection {
  /// roots ⋈ active-page-count, `WHERE live>0 [AND r.kind=?] ORDER BY r.slug`.
  public func listFrameworkRoots(kind: String?) -> [FrameworkRoot] {
    let kindClause = kind != nil ? " AND r.kind = $kind" : ""
    let sql = """
      SELECT r.slug, r.display_name, r.kind, COALESCE(c.n, 0) AS live_page_count
      FROM roots r
      LEFT JOIN (SELECT root_id, COUNT(*) AS n FROM pages WHERE status = 'active' GROUP BY root_id) c
        ON c.root_id = r.id
      WHERE COALESCE(c.n, 0) > 0\(kindClause)
      ORDER BY r.slug
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    if let kind { stmt.bind("$kind", .text(kind)) }
    var out: [FrameworkRoot] = []
    while stmt.step() == SQLite.row {
      out.append(
        FrameworkRoot(
          slug: stmt.text(0) ?? "", name: stmt.text(1) ?? "", kind: stmt.text(2) ?? "",
          pageCount: stmt.int(3) ?? 0))
    }
    return out
  }
}

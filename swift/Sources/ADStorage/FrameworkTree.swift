// Framework tree for /data/frameworks/<slug>/tree.<hash>.json (RFC 0001 P6, P3).
// Ports the queries behind src/web/templates/framework.js buildFrameworkTreeData:
// getRootBySlug (existence → 404), getDocumentsByRoot (the key→{title,role} lookup),
// getFrameworkTree (the child edges). Storage returns typed rows; ADServer frames
// {edges, docs} as ADJSON JSONValue (docs is a dynamic-key object → order-free).

public struct FrameworkTreeDoc: Sendable {
  public let path: String
  public let title: String?
  public let role: String?
  public let roleHeading: String?
}

public struct FrameworkTreeEdge: Sendable {
  public let fromKey: String
  public let toKey: String
}

extension StorageConnection {
  public func frameworkRootExists(_ slug: String) -> Bool {
    guard let stmt = conn.prepareUncached("SELECT 1 FROM roots WHERE slug = ?") else { return false }
    stmt.bindText(1, slug)
    return stmt.step() == SQLite.row
  }

  /// getDocumentsByRoot (documents.js getByRootSlugStmt) — the active pages of a
  /// root. Order-free downstream (the `docs` lookup is an object).
  public func frameworkTreeDocs(_ slug: String) -> [FrameworkTreeDoc] {
    let sql = """
      SELECT d.key, d.title, d.role, d.role_heading
      FROM documents d
      JOIN pages p ON p.path = d.key
      JOIN roots r ON p.root_id = r.id
      WHERE r.slug = ? AND p.status = 'active'
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    stmt.bindText(1, slug)
    var out: [FrameworkTreeDoc] = []
    while stmt.step() == SQLite.row {
      out.append(
        FrameworkTreeDoc(
          path: stmt.text(0) ?? "", title: stmt.text(1), role: stmt.text(2),
          roleHeading: stmt.text(3)))
    }
    return out
  }

  /// getFrameworkTree (documents.js): child edges. [] when document_relationships
  /// is absent (lite tier).
  public func frameworkTreeEdges(_ slug: String) -> [FrameworkTreeEdge] {
    guard conn.hasRelationships else { return [] }
    let sql = """
      SELECT dr.from_key, dr.to_key
      FROM document_relationships dr
      JOIN documents d ON d.key = dr.from_key
      WHERE d.framework = ? AND dr.relation_type = 'child'
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    stmt.bindText(1, slug)
    var out: [FrameworkTreeEdge] = []
    while stmt.step() == SQLite.row {
      out.append(FrameworkTreeEdge(fromKey: stmt.text(0) ?? "", toKey: stmt.text(1) ?? ""))
    }
    return out
  }
}

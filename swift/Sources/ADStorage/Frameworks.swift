// Documentation roots for the MCP list_frameworks tool: roots joined to
// their live (active) page counts, only those with at least one active page
// (zero-page catalog artifacts are noise). The projection keeps
// slug/name/kind/pageCount (status + last_seen are dropped).

public struct FrameworkRoot: Sendable {
    public let slug: String
    public let name: String
    public let kind: String
    public let pageCount: Int64
}

extension StorageConnection {
    /// roots with a live page, `WHERE page_count>0 [AND kind=?] ORDER BY slug`. `roots.page_count` is the
    /// maintained active-page count — verified identical, per root, to `COUNT(pages WHERE status='active')`
    /// — so we read it directly. That keeps this a single-table scan ADDB compiles cleanly, rather than the
    /// former `LEFT JOIN (… GROUP BY …)` derived table (which ADDB's planner can't build) or a per-root
    /// correlated aggregate (which it doesn't evaluate).
    public func listFrameworkRoots(kind: String?) -> [FrameworkRoot] {
        let kindClause = kind != nil ? " AND kind = $kind" : ""
        let sql = """
            SELECT slug, display_name, kind, page_count
            FROM roots
            WHERE page_count > 0\(kindClause)
            ORDER BY slug
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

// Reads the static web build needs beyond the MCP/read surface. The homepage
// roster reuses `listFrameworkRoots`; the /symbols lede totals come from here
// (mirrors src/web/view-models/symbols-page.viewmodel.js).

extension StorageConnection {
    /// `SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope` — the /symbols
    /// page lede totals (total / public / private). Empty when the table is absent.
    public func symbolScopeTotals() -> [(scope: String, count: Int)] {
        guard conn.tableExists("sf_symbols"),
            let stmt = conn.prepareUncached("SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope")
        else { return [] }
        var out: [(scope: String, count: Int)] = []
        while stmt.step() == SQLite.row {
            out.append((scope: stmt.text(0) ?? "", count: Int(stmt.int(1) ?? 0)))
        }
        return out
    }

    /// `SELECT value FROM snapshot_meta WHERE key = ?` — the install/build stamps
    /// (`snapshot_tag` / `snapshot_version` / `build_macos`) the footer shows.
    public func snapshotMeta(_ key: String) -> String? {
        guard let stmt = conn.prepareUncached("SELECT value FROM snapshot_meta WHERE key = ?") else { return nil }
        stmt.bindText(1, key)
        return stmt.step() == SQLite.row ? stmt.text(0) : nil
    }

    /// `db.getRoots()` for the sitemap walk: EVERY root (`SELECT slug, kind
    /// FROM roots ORDER BY slug`) — unlike `listFrameworkRoots`, roots with no
    /// active pages are included (their doc query decides whether a sitemap is
    /// written).
    public func sitemapRoots() -> [(slug: String, kind: String?)] {
        guard let stmt = conn.prepareUncached("SELECT slug, kind FROM roots ORDER BY slug") else { return [] }
        var out: [(slug: String, kind: String?)] = []
        while stmt.step() == SQLite.row {
            out.append((slug: stmt.text(0) ?? "", kind: stmt.text(1)))
        }
        return out
    }

    /// Every table name in the corpus (`SELECT name FROM sqlite_master WHERE
    /// type = 'table'` — includes FTS virtual tables and their shadow tables).
    /// The B0 read-spike derives its import skip-list from this.
    public func allTableNames() -> [String] {
        guard let stmt = conn.prepareUncached("SELECT name FROM sqlite_master WHERE type = 'table'")
        else { return [] }
        var out: [String] = []
        while stmt.step() == SQLite.row {
            if let name = stmt.text(0) { out.append(name) }
        }
        return out
    }

    /// The link audit's known-key universe: `SELECT path FROM pages WHERE
    /// status != 'deleted'` (every active page key, all source types).
    public func auditPageKeys() -> [String] {
        guard let stmt = conn.prepareUncached("SELECT path FROM pages WHERE status != 'deleted'") else {
            return []
        }
        var out: [String] = []
        while stmt.step() == SQLite.row {
            if let path = stmt.text(0) { out.append(path) }
        }
        return out
    }

    /// The per-framework sitemap rows: `SELECT key, role_heading FROM documents
    /// WHERE framework = ? ORDER BY key`.
    public func sitemapDocs(framework slug: String) -> [(key: String, roleHeading: String?)] {
        guard
            let stmt = conn.prepareUncached(
                "SELECT key, role_heading FROM documents WHERE framework = ? ORDER BY key")
        else { return [] }
        stmt.bindText(1, slug)
        var out: [(key: String, roleHeading: String?)] = []
        while stmt.step() == SQLite.row {
            out.append((key: stmt.text(0) ?? "", roleHeading: stmt.text(1)))
        }
        return out
    }
}

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
}

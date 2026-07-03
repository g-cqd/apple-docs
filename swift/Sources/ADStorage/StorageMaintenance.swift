// storage.js maintenance reads — the queries behind `storage stats` (per-table
// row counts) and `storage check-orphans` (PRAGMA foreign_key_check + the two
// semantic-orphan counts). SQL strings mirror src/commands/storage.js verbatim.

/// `storage stats`'s `tables` block: the five row counts in the JS insertion
/// order (documents, document_sections, pages, roots, crawl_state).
/// `document_sections` is 0 when the table is absent (lite tier).
public struct StorageTableCounts: Sendable {
    public let documents: Int64
    public let documentSections: Int64
    public let pages: Int64
    public let roots: Int64
    public let crawlState: Int64
}

extension StorageConnection {
    /// The five `SELECT COUNT(*)` reads of storage.js `storageStats`. A table
    /// the corpus lacks counts as 0 (the JS guards only document_sections; the
    /// other four exist in every migrated corpus).
    public func storageTableCounts() -> StorageTableCounts {
        StorageTableCounts(
            documents: scalarCount("SELECT COUNT(*) as count FROM documents"),
            documentSections: hasTable("document_sections")
                ? scalarCount("SELECT COUNT(*) as count FROM document_sections") : 0,
            pages: scalarCount("SELECT COUNT(*) as count FROM pages"),
            roots: scalarCount("SELECT COUNT(*) as count FROM roots"),
            crawlState: scalarCount("SELECT COUNT(*) as count FROM crawl_state"))
    }

    /// `PRAGMA foreign_key_check` rows, dynamic (column name, cell) pairs in
    /// engine order — `storage check-orphans` serializes them exactly as
    /// `JSON.stringify` sees bun:sqlite's row objects.
    public func foreignKeyCheck() -> [DynamicRow] {
        guard let stmt = conn.prepareUncached("PRAGMA foreign_key_check") else { return [] }
        return dynamicRows(stmt)
    }

    /// crawl_state rows whose root_slug no longer resolves to a root.
    public func crawlStateOrphanCount() -> Int64 {
        scalarCount(
            "SELECT COUNT(*) AS count FROM crawl_state WHERE root_slug NOT IN (SELECT slug FROM roots)")
    }

    /// documents keyed by a path no longer present in pages (0 when the
    /// documents table is absent, matching the JS hasTable guard).
    public func documentsMissingPageCount() -> Int64 {
        guard hasTable("documents") else { return 0 }
        return scalarCount(
            "SELECT COUNT(*) AS count FROM documents WHERE key NOT IN (SELECT path FROM pages)")
    }

    /// One-row COUNT: the first column of the first row, 0 when the statement
    /// cannot prepare (missing table) or yields no row.
    private func scalarCount(_ sql: String) -> Int64 {
        guard let stmt = conn.prepareUncached(sql), stmt.step() == SQLite.row else { return 0 }
        return stmt.int(0) ?? 0
    }
}

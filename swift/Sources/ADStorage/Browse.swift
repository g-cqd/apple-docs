// Queries for the MCP browse tool: resolveRoot (exact → fuzzy), getPagesByRoot,
// getPage (document then active-page fallback), getDocumentRelationships (children).

public struct BrowseRoot: Sendable {
    public let slug: String
    public let displayName: String
    public let kind: String
    public let sourceType: String
}

public struct BrowsePage: Sendable {
    public let path: String
    public let title: String?
    public let role: String?
    public let roleHeading: String?
    public let abstract: String?
}

public struct BrowseChild: Sendable {
    public let targetPath: String
    public let title: String?
    public let section: String?
}

extension StorageConnection {
    /// roots.js resolveRoot: exact slug → case-insensitive slug → display_name contains →
    /// slug substring → nil. The fuzzy passes scan all roots in `ORDER BY slug`.
    public func resolveRoot(_ input: String) -> BrowseRoot? {
        if let exact = rootRow("SELECT slug, display_name, kind, source_type FROM roots WHERE slug = ?", bind: input) {
            return exact
        }
        let lower = input.lowercased()
        let all = allRootRows()
        return all.first { $0.slug.lowercased() == lower }
            ?? all.first { $0.displayName.lowercased().contains(lower) }
            ?? all.first { $0.slug.contains(lower) }
    }

    /// getDocumentsByRoot: active pages of a root, joined to their documents, `ORDER BY d.key`.
    /// Joins through `p.path = d.key` — the LITERAL JS join (`repos/documents.js`
    /// `getDocumentsByRoot`), correct because `pages.path` and `documents.key` are BOTH the bare
    /// crawl key (e.g. `design/human-interface-guidelines`) under the JS persist convention.
    ///
    /// Full circle (RFC 0007 §11 findings #8/#9): the original port used this exact join, but the
    /// ADDB-era native crawl persisted the page's external URL into `pages.path`, so it never
    /// matched on a natively-crawled corpus — finding #8's fix (`2e657e7`) flipped it to
    /// `p.path = d.url`, which in turn could never match a JS-format corpus (finding #9, the
    /// harness's `browse adsupport` known issue). The storage pivot (D-0007-4) made the JS format
    /// THE corpus format and stage 2c converged `CrawlDriver` on persisting under the bare crawl
    /// key, so the original JS join is correct again — for both engines' corpora this time.
    public func pagesByRoot(_ slug: String) -> [BrowsePage] {
        let sql = """
            SELECT d.key, d.title, d.role, d.role_heading, d.abstract_text
            FROM documents d JOIN pages p ON p.path = d.key JOIN roots r ON p.root_id = r.id
            WHERE r.slug = ? AND p.status = 'active' ORDER BY d.key
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindText(1, slug)
        var out: [BrowsePage] = []
        while stmt.step() == SQLite.row {
            out.append(
                BrowsePage(
                    path: stmt.text(0) ?? "", title: stmt.text(1), role: stmt.text(2),
                    roleHeading: stmt.text(3), abstract: stmt.text(4)))
        }
        return out
    }

    /// getPage: the document row (key/title) if present, else the active pages row.
    public func browsePage(_ path: String) -> BrowsePage? {
        if let stmt = conn.prepareUncached("SELECT key, title FROM documents WHERE key = ?") {
            stmt.bindText(1, path)
            if stmt.step() == SQLite.row {
                return BrowsePage(
                    path: stmt.text(0) ?? path, title: stmt.text(1), role: nil, roleHeading: nil, abstract: nil)
            }
        }
        guard let stmt = conn.prepareUncached("SELECT path, title FROM pages WHERE path = ? AND status = 'active'")
        else { return nil }
        stmt.bindText(1, path)
        guard stmt.step() == SQLite.row else { return nil }
        return BrowsePage(path: stmt.text(0) ?? path, title: stmt.text(1), role: nil, roleHeading: nil, abstract: nil)
    }

    /// getRelationships: a page's children — `to_key` as path, `COALESCE(title, to_key)` as
    /// title, `COALESCE(section, relation_type)` as section; `ORDER BY sort_order, to_key`.
    public func documentChildren(_ key: String) -> [BrowseChild] {
        let sql = """
            SELECT dr.to_key, COALESCE(td.title, dr.to_key), COALESCE(dr.section, dr.relation_type)
            FROM document_relationships dr LEFT JOIN documents td ON td.key = dr.to_key
            WHERE dr.from_key = ? ORDER BY dr.sort_order, dr.to_key
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindText(1, key)
        var out: [BrowseChild] = []
        while stmt.step() == SQLite.row {
            out.append(BrowseChild(targetPath: stmt.text(0) ?? "", title: stmt.text(1), section: stmt.text(2)))
        }
        return out
    }

    private func rootRow(_ sql: String, bind: String) -> BrowseRoot? {
        guard let stmt = conn.prepareUncached(sql) else { return nil }
        stmt.bindText(1, bind)
        guard stmt.step() == SQLite.row else { return nil }
        return BrowseRoot(
            slug: stmt.text(0) ?? "", displayName: stmt.text(1) ?? "", kind: stmt.text(2) ?? "",
            sourceType: stmt.text(3) ?? "")
    }

    private func allRootRows() -> [BrowseRoot] {
        guard let stmt = conn.prepareUncached("SELECT slug, display_name, kind, source_type FROM roots ORDER BY slug")
        else { return [] }
        var out: [BrowseRoot] = []
        while stmt.step() == SQLite.row {
            out.append(
                BrowseRoot(
                    slug: stmt.text(0) ?? "", displayName: stmt.text(1) ?? "", kind: stmt.text(2) ?? "",
                    sourceType: stmt.text(3) ?? ""))
        }
        return out
    }
}

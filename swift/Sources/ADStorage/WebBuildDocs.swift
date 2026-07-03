// S5 — the corpus reads behind the full document render loop
// (src/web/build/document-pages.js + framework-pages.js + render-cache.js +
// the homepage view-model), plus the dynamic full-row fonts read the /fonts
// embedded-JSON parity needs.

/// One `roots` row as the build walks it (`getRoots()` = SELECT * FROM roots
/// ORDER BY slug — EVERY root, including ones the homepage roster filters out).
public struct WebBuildRoot: Sendable {
    public let slug: String
    public let displayName: String?
    public let kind: String?
    public let sourceType: String?
    /// `roots.page_count` (the maintained counter — the homepage filter's
    /// first tier; the live page count is a separate query).
    public let pageCount: Int64
}

/// One document row of the per-framework render loop (document-pages.js SQL).
public struct WebBuildDoc: Sendable {
    public let id: Int64
    public let key: String
    public let title: String?
    public let kind: String?
    public let role: String?
    public let roleHeading: String?
    public let framework: String?
    public let abstractText: String?
    public let sourceType: String?
    public let language: String?
    public let url: String?
    public let platformsJson: String?
    public let isDeprecated: Bool
    public let isBeta: Bool
    /// `COALESCE(r.display_name, d.framework)`.
    public let frameworkDisplay: String?
}

/// One framework-page listing row (`getPagesByRoot` = getDocumentsByRoot):
/// `d.key AS path, d.title, d.role, d.role_heading, d.abstract_text AS
/// abstract, d.source_metadata, d.framework` — root MEMBERSHIP (pages join),
/// not the `documents.framework` column.
public struct FrameworkPageDoc: Sendable {
    public let path: String
    public let title: String?
    public let role: String?
    public let roleHeading: String?
    public let abstract: String?
    public let sourceMetadata: String?
    public let framework: String?
}

/// One dynamic row: (column name, typed cell) in SELECT column order — the
/// fonts JSON parity serializes rows exactly as `JSON.stringify` sees them.
public struct DynamicRow: Sendable {
    public let cells: [(name: String, value: SQLiteCell)]
}

/// A typed SQLite result cell.
public enum SQLiteCell: Sendable {
    case text(String)
    case integer(Int64)
    case real(Double)
    case null
}

extension StorageConnection {
    /// `db.getRoots()` — SELECT * FROM roots ORDER BY slug, projected to the
    /// fields the build consumes.
    public func webBuildRoots() -> [WebBuildRoot] {
        guard
            let stmt = conn.prepareUncached(
                "SELECT slug, display_name, kind, source_type, page_count FROM roots ORDER BY slug")
        else { return [] }
        var out: [WebBuildRoot] = []
        while stmt.step() == SQLite.row {
            out.append(
                WebBuildRoot(
                    slug: stmt.text(0) ?? "", displayName: stmt.text(1), kind: stmt.text(2),
                    sourceType: stmt.text(3), pageCount: stmt.int(4) ?? 0))
        }
        return out
    }

    /// The document-pages.js per-framework enumerator:
    /// `SELECT d.id, d.key, …, COALESCE(r.display_name, d.framework) AS
    /// framework_display FROM documents d LEFT JOIN roots r ON r.slug =
    /// d.framework WHERE d.framework = ? ORDER BY d.id`.
    public func webBuildDocuments(framework slug: String) -> [WebBuildDoc] {
        let sql = """
            SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework,
                   d.abstract_text, d.source_type, d.language, d.url,
                   d.platforms_json, d.is_deprecated, d.is_beta,
                   COALESCE(r.display_name, d.framework) as framework_display
            FROM documents d LEFT JOIN roots r ON r.slug = d.framework
            WHERE d.framework = ? ORDER BY d.id
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindText(1, slug)
        var out: [WebBuildDoc] = []
        while stmt.step() == SQLite.row {
            out.append(
                WebBuildDoc(
                    id: stmt.int(0) ?? 0, key: stmt.text(1) ?? "", title: stmt.text(2),
                    kind: stmt.text(3), role: stmt.text(4), roleHeading: stmt.text(5),
                    framework: stmt.text(6), abstractText: stmt.text(7), sourceType: stmt.text(8),
                    language: stmt.text(9), url: stmt.text(10), platformsJson: stmt.text(11),
                    isDeprecated: (stmt.int(12) ?? 0) != 0, isBeta: (stmt.int(13) ?? 0) != 0,
                    frameworkDisplay: stmt.text(14)))
        }
        return out
    }

    /// render-cache.js `getKnownKeys()` — `SELECT key FROM documents` as a Set.
    public func knownDocumentKeys() -> Set<String> {
        guard let stmt = conn.prepareUncached("SELECT key FROM documents") else { return [] }
        var out = Set<String>()
        while stmt.step() == SQLite.row {
            if let key = stmt.text(0) { out.insert(key) }
        }
        return out
    }

    /// render-cache.js ancestor-title index — `SELECT key, title FROM documents
    /// WHERE title IS NOT NULL`.
    public func ancestorTitleIndex() -> [String: String] {
        guard let stmt = conn.prepareUncached("SELECT key, title FROM documents WHERE title IS NOT NULL")
        else { return [:] }
        var out: [String: String] = [:]
        while stmt.step() == SQLite.row {
            if let key = stmt.text(0), let title = stmt.text(1) { out[key] = title }
        }
        return out
    }

    /// render-cache.js role-heading index — `SELECT key, role_heading FROM
    /// documents WHERE role_heading IS NOT NULL`.
    public func roleHeadingIndex() -> [String: String] {
        guard
            let stmt = conn.prepareUncached(
                "SELECT key, role_heading FROM documents WHERE role_heading IS NOT NULL")
        else { return [:] }
        var out: [String: String] = [:]
        while stmt.step() == SQLite.row {
            if let key = stmt.text(0), let heading = stmt.text(1) { out[key] = heading }
        }
        return out
    }

    /// `getPagesByRoot` (getDocumentsByRoot) — the framework listing page's doc
    /// rows + the homepage self-page filter's probe.
    public func frameworkPageDocs(root slug: String) -> [FrameworkPageDoc] {
        let sql = """
            SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
                   d.source_metadata, d.framework
            FROM documents d
            JOIN pages p ON p.path = d.key
            JOIN roots r ON p.root_id = r.id
            WHERE r.slug = ? AND p.status = 'active'
            ORDER BY d.key
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        stmt.bindText(1, slug)
        var out: [FrameworkPageDoc] = []
        while stmt.step() == SQLite.row {
            out.append(
                FrameworkPageDoc(
                    path: stmt.text(0) ?? "", title: stmt.text(1), role: stmt.text(2),
                    roleHeading: stmt.text(3), abstract: stmt.text(4), sourceMetadata: stmt.text(5),
                    framework: stmt.text(6)))
        }
        return out
    }

    /// build.js step 8 — `SELECT COUNT(*) FROM documents WHERE framework = ?`.
    public func documentCount(framework slug: String) -> Int {
        guard let stmt = conn.prepareUncached("SELECT COUNT(*) as count FROM documents WHERE framework = ?")
        else { return 0 }
        stmt.bindText(1, slug)
        guard stmt.step() == SQLite.row else { return 0 }
        return Int(stmt.int(0) ?? 0)
    }

    /// scope-group-data.js `loadScopeExtras` — the HIG category rows:
    /// child relationships under design/%, joined to the parent's title, plus
    /// the canonical category order from the HIG landing page's children.
    public func higCategoryRows() -> (
        rows: [(parent: String, parentTitle: String?, child: String)], order: [String]
    ) {
        var rows: [(parent: String, parentTitle: String?, child: String)] = []
        if let stmt = conn.prepareUncached(
            "SELECT dr.from_key AS parent, d.title AS parent_title, dr.to_key AS child FROM document_relationships dr JOIN documents d ON d.key = dr.from_key WHERE dr.relation_type = 'child' AND dr.from_key LIKE 'design/%'")
        {
            while stmt.step() == SQLite.row {
                rows.append((parent: stmt.text(0) ?? "", parentTitle: stmt.text(1), child: stmt.text(2) ?? ""))
            }
        }
        var order: [String] = []
        if let stmt = conn.prepareUncached(
            "SELECT to_key FROM document_relationships WHERE from_key = 'design/human-interface-guidelines' AND relation_type = 'child' ORDER BY sort_order, to_key")
        {
            while stmt.step() == SQLite.row {
                if let key = stmt.text(0) { order.append(key) }
            }
        }
        return (rows: rows, order: order)
    }

    /// The FULL `apple_font_families` rows (`SELECT * … ORDER BY display_name`)
    /// as dynamic (name, cell) pairs in column order — `listAppleFonts()`
    /// spreads whole rows into the embedded JSON, so key order must be the
    /// live table's column order. nil when the table is absent.
    public func appleFontFamilyRows() -> [DynamicRow]? {
        guard conn.tableExists("apple_font_families"),
            let stmt = conn.prepareUncached("SELECT * FROM apple_font_families ORDER BY display_name")
        else { return nil }
        return dynamicRows(stmt)
    }

    /// The FULL `apple_font_files` rows (`SELECT * … ORDER BY family_id,
    /// file_name`). nil when the table is absent.
    public func appleFontFileRows() -> [DynamicRow]? {
        guard conn.tableExists("apple_font_files"),
            let stmt = conn.prepareUncached("SELECT * FROM apple_font_files ORDER BY family_id, file_name")
        else { return nil }
        return dynamicRows(stmt)
    }

    func dynamicRows(_ stmt: PreparedStatement) -> [DynamicRow] {
        let count = stmt.columnCount()
        var names: [String] = []
        names.reserveCapacity(Int(count))
        for i in 0..<count { names.append(stmt.columnName(i) ?? "") }
        var out: [DynamicRow] = []
        while stmt.step() == SQLite.row {
            var cells: [(name: String, value: SQLiteCell)] = []
            cells.reserveCapacity(Int(count))
            for i in 0..<count {
                let value: SQLiteCell
                switch stmt.columnType(i) {
                case SQLite.typeNull: value = .null
                case SQLite.typeInteger: value = .integer(stmt.int(i) ?? 0)
                case SQLite.typeFloat: value = .real(stmt.double(i) ?? 0)
                default: value = .text(stmt.text(i) ?? "")
                }
                cells.append((name: names[Int(i)], value: value))
            }
            out.append(DynamicRow(cells: cells))
        }
        return out
    }
}

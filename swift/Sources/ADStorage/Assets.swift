// Asset queries for the /api/fonts + /api/symbols routes. Storage returns
// typed rows; ADServer frames the JSON/CSS.

public struct AppleFontFile: Sendable {
    public let id: String
    public let fileName: String
    public let format: String?
}

public struct AppleFontFamily: Sendable {
    public let id: String
    public let files: [AppleFontFile]
}

/// One `apple_font_files` row by id, joined to its family — the columns the
/// `apple-docs://font/{id}` resource and the render_font_text handler need (JS:
/// `db.getAppleFontFile(id)` returns `f.*` plus `fam.display_name AS
/// family_display_name`). nil = the id is absent (→ NotFoundError parity).
public struct AppleFontFileRecord: Sendable {
    public let id: String
    public let filePath: String?
    public let format: String?
    public let familyDisplayName: String?
}

extension StorageConnection {
    /// `apple_font_files` ⋈ `apple_font_families` lookup by id (JS `getFontFile`).
    /// nil = no such row / the table is absent.
    public func getAppleFontFileRecord(id: String) -> AppleFontFileRecord? {
        let sql = """
            SELECT f.id, f.file_path, f.format, fam.display_name
            FROM apple_font_files f JOIN apple_font_families fam ON fam.id = f.family_id
            WHERE f.id = ?
            """
        guard let stmt = conn.prepareUncached(sql) else { return nil }
        stmt.bindText(1, id)
        guard stmt.step() == SQLite.row, let rowId = stmt.text(0) else { return nil }
        return AppleFontFileRecord(
            id: rowId, filePath: stmt.text(1), format: stmt.text(2), familyDisplayName: stmt.text(3))
    }

    /// families ⋈ files: families ORDER BY display_name, each family's files
    /// in (family_id, file_name) order. [] when the tables are absent.
    public func listAppleFonts() -> [AppleFontFamily] {
        guard
            let famStmt = conn.prepareUncached("SELECT id FROM apple_font_families ORDER BY display_name")
        else { return [] }
        var familyIds: [String] = []
        while famStmt.step() == SQLite.row {
            if let id = famStmt.text(0) { familyIds.append(id) }
        }
        guard
            let fileStmt = conn.prepareUncached(
                "SELECT family_id, id, file_name, format FROM apple_font_files ORDER BY family_id, file_name")
        else {
            return familyIds.map { AppleFontFamily(id: $0, files: []) }
        }
        var byFamily: [String: [AppleFontFile]] = [:]
        while fileStmt.step() == SQLite.row {
            guard let familyId = fileStmt.text(0), let id = fileStmt.text(1), let fileName = fileStmt.text(2)
            else { continue }
            byFamily[familyId, default: []]
                .append(
                    AppleFontFile(id: id, fileName: fileName, format: fileStmt.text(3)))
        }
        return familyIds.map { AppleFontFamily(id: $0, files: byFamily[$0] ?? []) }
    }
}

// MARK: - SF Symbols (/api/symbols/*)

/// The light projection for /api/symbols/index.json.
public struct SfCatalogRow: Sendable {
    public let name: String
    public let scope: String
    public let categoriesJson: String?
    public let keywordsJson: String?
    public let bitmapOnly: Int64?
    public let renderUnsupported: Int64?
    public let codepoint: Int64?
    public let codepointVersion: String?
}

/// The full `sf_symbols` row for /api/symbols/search + /<scope>/<name>.json
/// (every column verbatim; `bitmap_only`/`render_unsupported` stay 0/1 INTs).
/// The 4 `*_json` columns are parsed by the caller (ADServer) into
/// `categories`/`keywords`/`aliases`/`availability`.
public struct SfSymbolRow: Sendable {
    public let name: String
    public let scope: String
    public let categoriesJson: String?
    public let keywordsJson: String?
    public let aliasesJson: String?
    public let availabilityJson: String?
    public let orderIndex: Int64?
    public let bundlePath: String?
    public let bundleVersion: String?
    public let updatedAt: String?
    public let codepoint: Int64?
    public let codepointVersion: String?
    public let bitmapOnly: Int64?
    public let renderUnsupported: Int64?
}

private let sfCols =
    "name, scope, categories_json, keywords_json, aliases_json, availability_json, order_index, bundle_path, bundle_version, updated_at, codepoint, codepoint_version, bitmap_only, render_unsupported"
private let sfColsS =
    "s.name, s.scope, s.categories_json, s.keywords_json, s.aliases_json, s.availability_json, s.order_index, s.bundle_path, s.bundle_version, s.updated_at, s.codepoint, s.codepoint_version, s.bitmap_only, s.render_unsupported"

private func readSfSymbolRow(_ stmt: PreparedStatement) -> SfSymbolRow {
    SfSymbolRow(
        name: stmt.text(0) ?? "", scope: stmt.text(1) ?? "", categoriesJson: stmt.text(2),
        keywordsJson: stmt.text(3), aliasesJson: stmt.text(4), availabilityJson: stmt.text(5),
        orderIndex: stmt.int(6), bundlePath: stmt.text(7), bundleVersion: stmt.text(8),
        updatedAt: stmt.text(9), codepoint: stmt.int(10), codepointVersion: stmt.text(11),
        bitmapOnly: stmt.int(12), renderUnsupported: stmt.int(13))
}

/// FTS5 MATCH builder: lowercase, split on non-`[a-z0-9_.-]`, cap 8 terms,
/// `"term"*` joined by OR (terms hold no quotes, so no escaping needed).
func buildResourceFtsQuery(_ query: String) -> String {
    let lowered = query.lowercased()
    var terms: [String] = []
    var current = ""
    for ch in lowered {
        if let a = ch.asciiValue,
            (a >= 0x61 && a <= 0x7A) || (a >= 0x30 && a <= 0x39) || a == 0x5F || a == 0x2E || a == 0x2D
        {
            current.append(ch)
        } else if !current.isEmpty {
            terms.append(current)
            current = ""
        }
    }
    if !current.isEmpty { terms.append(current) }
    let capped = terms.prefix(8)
    if capped.isEmpty { return "\"\"" }
    return capped.map { "\"\($0)\"*" }.joined(separator: " OR ")
}

private func jsTrim(_ s: String) -> String {
    var sub = Substring(s)
    while let f = sub.first, f == " " || f == "\t" || f == "\n" || f == "\r" { sub = sub.dropFirst() }
    while let l = sub.last, l == " " || l == "\t" || l == "\n" || l == "\r" { sub = sub.dropLast() }
    return String(sub)
}

extension StorageConnection {
    /// /api/symbols/index.json — ORDER BY scope, COALESCE(order_index,999999), name.
    public func listSfSymbolsCatalog() -> [SfCatalogRow] {
        let sql = """
            SELECT name, scope, categories_json, keywords_json, bitmap_only, render_unsupported, codepoint, codepoint_version
            FROM sf_symbols
            ORDER BY scope, COALESCE(order_index, 999999), name
            """
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        var out: [SfCatalogRow] = []
        while stmt.step() == SQLite.row {
            out.append(
                SfCatalogRow(
                    name: stmt.text(0) ?? "", scope: stmt.text(1) ?? "", categoriesJson: stmt.text(2),
                    keywordsJson: stmt.text(3), bitmapOnly: stmt.int(4), renderUnsupported: stmt.int(5),
                    codepoint: stmt.int(6), codepointVersion: stmt.text(7)))
        }
        return out
    }

    /// /api/symbols/<scope>/<name>.json — nil = 404.
    public func getSfSymbol(scope: String, name: String) -> SfSymbolRow? {
        guard let stmt = conn.prepareUncached("SELECT \(sfCols) FROM sf_symbols WHERE scope = ? AND name = ?")
        else { return nil }
        stmt.bindText(1, scope)
        stmt.bindText(2, name)
        guard stmt.step() == SQLite.row else { return nil }
        return readSfSymbolRow(stmt)
    }

    /// /api/symbols/search: empty → list; else FTS5 `MATCH`, falling back to
    /// `LIKE` when FTS5 trips on the query. `limit` is the already-clamped
    /// `[1,500]` value; `scope` nil = all scopes.
    public func searchSfSymbols(query: String, scope: String?, limit: Int) -> [SfSymbolRow] {
        let q = jsTrim(query)
        let scopeBind: BindValue = scope.map { .text($0) } ?? .null
        let lim = BindValue.int(Int64(limit))
        if q.isEmpty {
            let sql = """
                SELECT \(sfCols) FROM sf_symbols
                WHERE ($scope IS NULL OR scope = $scope)
                ORDER BY scope, COALESCE(order_index, 999999), name LIMIT $limit
                """
            return runSymbolRows(sql, [("$scope", scopeBind), ("$limit", lim)]) ?? []
        }
        let ftsSql = """
            SELECT \(sfColsS) FROM sf_symbols_fts f JOIN sf_symbols s ON s.rowid = f.rowid
            WHERE sf_symbols_fts MATCH $query AND ($scope IS NULL OR s.scope = $scope)
            ORDER BY bm25(sf_symbols_fts), COALESCE(s.order_index, 999999), s.name LIMIT $limit
            """
        if let rows = runSymbolRows(
            ftsSql, [("$query", .text(buildResourceFtsQuery(q))), ("$scope", scopeBind), ("$limit", lim)])
        {
            return rows
        }
        let likeSql = """
            SELECT \(sfCols) FROM sf_symbols
            WHERE ($scope IS NULL OR scope = $scope) AND (
              LOWER(name) LIKE $like OR LOWER(COALESCE(keywords_json, '')) LIKE $like
              OR LOWER(COALESCE(categories_json, '')) LIKE $like OR LOWER(COALESCE(aliases_json, '')) LIKE $like
            )
            ORDER BY scope, COALESCE(order_index, 999999), name LIMIT $limit
            """
        return runSymbolRows(
            likeSql, [("$scope", scopeBind), ("$like", .text("%\(q.lowercased())%")), ("$limit", lim)]) ?? []
    }

    /// Steps a named-bound symbol query; nil signals a step error (the FTS5 parse
    /// failure → LIKE fallback), [] when the table/statement is absent.
    private func runSymbolRows(_ sql: String, _ binds: [(String, BindValue)]) -> [SfSymbolRow]? {
        guard let stmt = conn.prepareUncached(sql) else { return [] }
        for (name, value) in binds { stmt.bind(name, value) }
        var out: [SfSymbolRow] = []
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { return nil }
            out.append(readSfSymbolRow(stmt))
        }
        return out
    }
}

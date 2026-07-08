// Extracts the NATIVE-migrated SQLite catalog into the engine-agnostic
// ``CatalogModel`` for the parity gate. Runs the SAME introspection the bun
// fixture-capture script runs (`sqlite_master` → `PRAGMA table_info` /
// `index_info` / `index_list`), emits the SAME line-based manifest, and reuses
// ``SQLiteReferenceExtractor/parse(_:)`` — so the native side and the committed
// JS reference are projected through ONE normalizer, and any catalog difference
// is a real schema difference, never a projection artifact.

import ADStorage
import Foundation

@testable import ADWrite

enum NativeCatalogExtractor {
    /// Migrate a fresh SQLite database in `directory` via the production
    /// `migrateSchema` and return its normalized catalog + the migrate outcome.
    static func build(inDirectory directory: String) throws -> (CatalogModel, MigrateOutcome) {
        let connection = try SQLiteWriteConnection(path: directory + "/native.db")
        defer { connection.close() }
        let outcome = try migrateSchema(connection)
        let catalog = try SQLiteReferenceExtractor.parse(manifest(connection))
        return (catalog, outcome)
    }

    /// The line-based schema manifest (the grammar documented on
    /// `SQLiteReferenceExtractor.manifestScript`), read from a live connection.
    static func manifest(_ db: SQLiteWriteConnection) throws -> String {
        let objects = try db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")

        var ftsBases: Set<String> = []
        for object in objects where object.text("type") == "table" {
            guard let sql = object.text("sql"), let name = object.text("name") else { continue }
            if isFTS5(sql) { ftsBases.insert(name) }
        }

        var out: [String] = []
        for object in objects {
            let name = object.text("name") ?? ""
            switch object.text("type") {
                case "table":
                    if name.hasPrefix("sqlite_") { continue }
                    if ftsBases.contains(name) {
                        let fts = parseFTS(object.text("sql") ?? "")
                        out.append("F|\(name)|\(fts.cols.joined(separator: ","))|\(fts.tokenize)|\(fts.contentSpec)")
                        continue
                    }
                    if SchemaNormalize.isFTSShadow(name, ftsBases: ftsBases) { continue }
                    out.append("T|\(name)")
                    for column in try db.all("SELECT * FROM pragma_table_info('\(name)')") {
                        let dflt = column.text("dflt_value") ?? dfltNonText(column["dflt_value"])
                        out.append(
                            "C|\(name)|\(column.int("cid") ?? 0)|\(column.text("name") ?? "")"
                                + "|\(column.text("type") ?? "")|\(column.int("notnull") ?? 0)"
                                + "|\(dflt)|\(column.int("pk") ?? 0)")
                    }
                case "index":
                    let table = object.text("tbl_name") ?? ""
                    if ftsBases.contains(table) { continue }
                    let cols = try db.all("SELECT name FROM pragma_index_info('\(name)')")
                        .map { $0.text("name") ?? "" }
                    let unique =
                        try db
                        .all(
                            "SELECT \"unique\" AS u FROM pragma_index_list('\(table)') WHERE name = $n",
                            ["n": .text(name)]
                        )
                        .first?
                        .int("u") ?? 0
                    out.append("I|\(name)|\(table)|\(unique)|\(cols.joined(separator: ","))")
                case "trigger":
                    let b64 = Data((object.text("sql") ?? "").utf8).base64EncodedString()
                    out.append("G|\(name)|\(b64)")
                default:
                    continue
            }
        }
        return out.joined(separator: "\n")
    }

    /// A non-TEXT `dflt_value` cell (SQLite stores integer defaults as INTEGER in
    /// table_info) rendered like the JS `String(c.dflt_value)`; NULL → the sentinel.
    private static func dfltNonText(_ value: SQLiteValue?) -> String {
        switch value {
            case .integer(let v): return String(v)
            case .real(let v): return String(v)
            default: return SQLiteReferenceExtractor.noDefaultSentinel
        }
    }

    private static func isFTS5(_ sql: String) -> Bool {
        sql.range(of: #"USING\s+fts5"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// The Swift port of the capture script's `parseFTS` (same field grammar:
    /// greedy body to the LAST `)`, `key=value` options vs bare columns).
    static func parseFTS(_ sql: String) -> (cols: [String], tokenize: String, contentSpec: String) {
        var body = ""
        if let match = sql.range(of: #"USING\s+fts5\s*\("#, options: [.regularExpression, .caseInsensitive]),
            let close = sql.range(of: ")", options: .backwards)
        {
            body = String(sql[match.upperBound ..< close.lowerBound])
        }
        var cols: [String] = []
        var tokenize = "unicode61"
        var contentTable: String?
        var contentRowid = "rowid"
        var contentless = false
        var deleteEnabled = false
        for rawPart in body.split(separator: ",") {
            let part = rawPart.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !part.isEmpty else { continue }
            guard let eq = part.firstIndex(of: "=") else {
                cols.append(part)
                continue
            }
            let key = part[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
            var value = part[part.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("'"), value.hasSuffix("'"), value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }
            switch key {
                case "tokenize": tokenize = value
                case "content":
                    if value.isEmpty { contentless = true } else { contentTable = value }
                case "content_rowid": contentRowid = value
                case "contentless_delete": deleteEnabled = value == "1"
                default: break
            }
        }
        let contentSpec: String
        if contentless {
            contentSpec = "contentless:\(deleteEnabled ? 1 : 0)"
        } else if let contentTable {
            contentSpec = "external:\(contentTable):\(contentRowid)"
        } else {
            contentSpec = "self"
        }
        return (cols, tokenize, contentSpec)
    }
}

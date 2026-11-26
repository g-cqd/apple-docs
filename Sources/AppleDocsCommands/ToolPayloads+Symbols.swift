public import AemiJSONCore
import AppleDocsCore
public import AppleDocsStorage
import Foundation
import OrderedCollections

/// Port of Bun's `searchSfSymbols` (`storage/repos/assets-symbols.js`).
extension ToolPayloads {
    /// FTS (prefix terms, bm25) with a LIKE fallback; every scope unless `scope` is given.
    public static func sfSymbols(
        query: String?,
        scope: String?,
        limit: Int?,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> JSONValue {
        let clamped = Int64(max(1, min(limit ?? 100, 500)))
        let text = (query ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let columns: [Column] = [.text("name"), .text("scope")]
        let scoped: [SQLiteValue] = [.optionalText(scope), .optionalText(scope)]
        let results: [JSONValue]
        if text.isEmpty {
            results = try objects(
                """
                SELECT name, scope FROM sf_symbols WHERE (? IS NULL OR scope = ?)
                ORDER BY scope, COALESCE(order_index, 999999), name LIMIT ?
                """,
                bindings: scoped + [.integer(clamped)],
                columns: columns,
                on: connection
            )
        } else if let fts = try? objects(
            """
            SELECT s.name, s.scope FROM sf_symbols_fts f JOIN sf_symbols s ON s.rowid = f.rowid
            WHERE sf_symbols_fts MATCH ? AND (? IS NULL OR s.scope = ?)
            ORDER BY bm25(sf_symbols_fts), COALESCE(s.order_index, 999999), s.name LIMIT ?
            """,
            bindings: [.text(resourceFTSQuery(text))] + scoped + [.integer(clamped)],
            columns: columns,
            on: connection
        ) {
            results = fts
        } else {
            let like = SQLiteValue.text("%\(text.lowercased())%")
            results = try objects(
                """
                SELECT name, scope FROM sf_symbols WHERE (? IS NULL OR scope = ?) AND (
                  LOWER(name) LIKE ? OR LOWER(COALESCE(keywords_json, '')) LIKE ?
                  OR LOWER(COALESCE(categories_json, '')) LIKE ? OR LOWER(COALESCE(aliases_json, '')) LIKE ?)
                ORDER BY scope, COALESCE(order_index, 999999), name LIMIT ?
                """,
                bindings: scoped + [like, like, like, like, .integer(clamped)],
                columns: columns,
                on: connection
            )
        }
        return .object(["results": .array(results), "query": .string(text), "scope": DocCValue.optional(scope)])
    }

    /// `buildResourceFtsQuery`: up to 8 lowercase `[a-z0-9_.-]` terms as quoted prefix terms joined by `OR`.
    static func resourceFTSQuery(_ query: String) -> String {
        let terms = query.lowercased()
            .split { character in
                !(character.isASCII && (character.isLetter || character.isNumber || "_.-".contains(character)))
            }
            .prefix(8)
            .map { "\"\(String($0).replacingScalars("\"", with: "\"\""))\"*" }
        return terms.isEmpty ? "\"\"" : terms.joined(separator: " OR ")
    }
}

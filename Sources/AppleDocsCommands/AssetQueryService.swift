public import AppleDocsOutput
import AppleDocsSearch
public import AppleDocsStorage
import Foundation

/// Cross-platform SF Symbols and Apple Fonts query service over a Swift v1 ``SQLiteConnection``.
public enum AssetQueryService: Sendable {
    /// Searches `sf_symbols` by name, keyword, category, or alias within `scope` (`public` or `private`).
    public static func searchSFSymbols(
        query: String,
        scope: String = "public",
        limit: Int = 100,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicSFSymbol] {
        let validScope = (scope == "private") ? "private" : "public"
        let clampedLimit = max(1, min(limit, 500))
        let trimmed = FTSQueryBuilder.trimWhitespace(query)

        let rows: [SQLiteRow]
        if trimmed.isEmpty {
            rows = try connection.query(
                """
                SELECT name, scope, categories_json, keywords_json, aliases_json, codepoint, bitmap_only
                FROM sf_symbols
                WHERE scope = ?
                ORDER BY COALESCE(order_index, 9999999) ASC, name ASC
                LIMIT ?
                """,
                bindings: [.text(validScope), .integer(Int64(clampedLimit))]
            )
        } else {
            let pattern = "%\(CorpusQueryService.escapeLike(trimmed.lowercased()))%"
            rows = try connection.query(
                """
                SELECT s.name, s.scope, s.categories_json, s.keywords_json, s.aliases_json,
                       s.codepoint, s.bitmap_only
                FROM sf_symbols s
                WHERE s.scope = ?
                  AND (
                      LOWER(s.name) LIKE ? ESCAPE '\\'
                      OR LOWER(COALESCE(s.keywords_json, '')) LIKE ? ESCAPE '\\'
                      OR LOWER(COALESCE(s.categories_json, '')) LIKE ? ESCAPE '\\'
                      OR LOWER(COALESCE(s.aliases_json, '')) LIKE ? ESCAPE '\\'
                  )
                ORDER BY CASE WHEN LOWER(s.name) = ? THEN 0
                              WHEN LOWER(s.name) LIKE ? ESCAPE '\\' THEN 1
                              ELSE 2 END,
                         COALESCE(s.order_index, 9999999) ASC, s.name ASC
                LIMIT ?
                """,
                bindings: [
                    .text(validScope),
                    .text(pattern),
                    .text(pattern),
                    .text(pattern),
                    .text(pattern),
                    .text(trimmed.lowercased()),
                    .text("\(CorpusQueryService.escapeLike(trimmed.lowercased()))%"),
                    .integer(Int64(clampedLimit))
                ]
            )
        }
        return try rows.map(Self.decodeSymbol)
    }

    /// Lists all indexed Apple Font families along with their public font file descriptors.
    public static func listAppleFonts(
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PublicAppleFontFamily] {
        let familyRows = try connection.query(
            """
            SELECT id, display_name, category, status
            FROM apple_font_families
            ORDER BY display_name ASC
            """
        )
        let fileRows = try connection.query(
            """
            SELECT family_id, id, file_name, postscript_name, style_name, weight, italic, format, is_variable
            FROM apple_font_files
            ORDER BY family_id ASC, file_name ASC
            """
        )
        var filesByFamily: [String: [PublicAppleFontFamily.FontFile]] = [:]
        for row in fileRows {
            let familyID = try row.text(at: 0)
            let file = PublicAppleFontFamily.FontFile(
                id: try row.text(at: 1),
                fileName: try row.text(at: 2),
                postscriptName: try row.optionalText(at: 3),
                styleName: try row.optionalText(at: 4),
                weight: try row.optionalText(at: 5),
                italic: try row.bool(at: 6),
                format: try row.optionalText(at: 7),
                isVariable: try row.bool(at: 8)
            )
            filesByFamily[familyID, default: []].append(file)
        }
        return try familyRows.map { row throws(SQLiteError) in
            let id = try row.text(at: 0)
            return PublicAppleFontFamily(
                id: id,
                displayName: try row.text(at: 1),
                category: try row.optionalText(at: 2),
                status: try row.text(at: 3),
                files: filesByFamily[id] ?? []
            )
        }
    }

    private static func decodeSymbol(_ row: SQLiteRow) throws(SQLiteError) -> PublicSFSymbol {
        PublicSFSymbol(
            name: try row.text(at: 0),
            scope: try row.text(at: 1),
            categories: decodeStringArray(try row.optionalText(at: 2)),
            keywords: decodeStringArray(try row.optionalText(at: 3)),
            aliases: decodeStringArray(try row.optionalText(at: 4)),
            codepoint: try row.optionalInteger(at: 5).map(Int.init),
            bitmapOnly: try row.bool(at: 6)
        )
    }

    private static func decodeStringArray(_ rawJSON: String?) -> [String] {
        guard let rawJSON, !rawJSON.isEmpty,
            let decoded = try? JSONDecoder().decode([String].self, from: Data(rawJSON.utf8))
        else {
            return []
        }
        return decoded
    }
}

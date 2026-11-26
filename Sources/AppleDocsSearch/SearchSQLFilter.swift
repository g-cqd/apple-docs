import AppleDocsCore
import AppleDocsStorage
import Foundation

/// Bun's SQL-side search filters (`FILTER_PREDICATES` / `buildFilterParams` in `search-sql.js`), bound by name.
/// Platform minimums are applied after the query (as Bun's cascade does), so no `*_num` predicates appear here.
public struct SearchSQLFilter: Sendable {
    public var framework: String?
    public var sourceType: String?
    public var sources: [String]?
    public var language: String?
    public var year: Int?
    public var track: String?
    public var deprecatedMode: String
    public var limit: Int

    static let predicates = """
        AND ($framework IS NULL OR d.framework = $framework)
        AND ($source_type IS NULL OR d.source_type = $source_type)
        AND ($sources_json IS NULL OR d.source_type IN (SELECT value FROM json_each($sources_json)))
        AND (
          $kind IS NULL
          OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
          OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
        )
        AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
        AND ($year IS NULL OR CAST(json_extract(d.source_metadata, '$.year') AS INTEGER) = $year)
        AND ($track_like IS NULL OR LOWER(COALESCE(json_extract(d.source_metadata, '$.track'), '')) LIKE $track_like)
        AND (
          $deprecated_mode = 'include'
          OR ($deprecated_mode = 'exclude' AND COALESCE(d.is_deprecated, 0) = 0)
          OR ($deprecated_mode = 'only'    AND COALESCE(d.is_deprecated, 0) = 1)
        )
        """

    /// The same filter scoped to `framework` (the cascade runs once per framework synonym).
    func scoped(to framework: String?) -> SearchSQLFilter {
        var copy = self
        copy.framework = framework
        return copy
    }

    /// Named bindings for ``predicates`` plus `$limit`.
    var bindings: [String: SQLiteValue] {
        let trimmedTrack = track?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sourcesJSON = sources.flatMap { list -> String? in
            guard !list.isEmpty else { return nil }
            let quoted = list.map { "\"" + $0.replacingScalars(["\\": "\\\\", "\"": "\\\""]) + "\"" }
            return "[" + quoted.joined(separator: ",") + "]"
        }
        return [
            "$framework": .optionalText(framework),
            "$kind": .null,
            "$language": .optionalText(language),
            "$source_type": .optionalText(sourceType),
            "$sources_json": .optionalText(sourcesJSON),
            "$year": year.map { .integer(Int64($0)) } ?? .null,
            "$track_like": .optionalText(trimmedTrack.flatMap { $0.isEmpty ? nil : "%\($0.lowercased())%" }),
            "$deprecated_mode": .text(
                ["include", "exclude", "only"].contains(deprecatedMode) ? deprecatedMode : "include"
            ),
            "$limit": .integer(Int64(limit))
        ]
    }
}

public import AemiJSONCore
import OrderedCollections

/// One ranked search result (Bun's `formatResult` shape plus `score`, `snippet`, and `relatedCount`).
public struct SearchResultItem: Sendable {
    public var record: SearchRecord
    /// `exact`, `prefix`, `contains`, `match`, `substring`, `fuzzy`, `body`, `relaxed…`, or `semantic`.
    public var matchQuality: String
    public var distance: Int?
    public var score: Double?
    public var snippet: String?
    public var relatedCount: Int?

    /// Parsed `platforms_json` (`[]` when absent or invalid, as `formatResult` yields).
    public var platforms: JSONValue {
        guard let raw = record.platforms, let parsed = try? AemiJSON.parse(Array(raw.utf8)).root, !parsed.isNull else {
            return .array([])
        }
        return JSONValue(parsed)
    }

    public var path: String { record.path }

    /// The result as Bun serializes it (keys in `formatResult` order; `undefined` fields omitted).
    public var jsonValue: JSONValue {
        func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        var object: OrderedDictionary<String, JSONValue> = [
            "title": optional(record.title),
            "framework": optional(record.framework),
            "rootSlug": optional(record.rootSlug),
            "sourceType": optional(record.sourceType),
            "sourceMetadata": optional(record.sourceMetadata),
            "kind": optional(record.roleHeading ?? record.role),
            "abstract": optional(record.abstract),
            "path": .string(record.path),
            "platforms": platforms,
            "declaration": optional(record.declaration),
            "urlDepth": .int(record.urlDepth ?? 0),
            "isReleaseNotes": .bool(record.isReleaseNotes),
            "language": optional(record.language)
        ]
        if record.isDeprecated { object["isDeprecated"] = .bool(true) }
        if record.isBeta { object["isBeta"] = .bool(true) }
        object["matchQuality"] = .string(matchQuality)
        if let distance { object["distance"] = .int(Int64(distance)) }
        if let score { object["score"] = .number(score) }
        if let snippet { object["snippet"] = .string(snippet) }
        if let relatedCount { object["relatedCount"] = .int(Int64(relatedCount)) }
        return .object(object)
    }
}

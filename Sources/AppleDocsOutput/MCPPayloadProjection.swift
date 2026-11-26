public import AemiJSONCore
import OrderedCollections

/// Port of Bun's `output/projection.js` for the MCP tool payloads: strict allowlists over the rich command
/// envelopes (``JSONValue``) so internal fields (pagination strategy, budgets, DB columns) never reach clients.
public enum MCPPayloadProjection {
    typealias Object = OrderedDictionary<String, JSONValue>

    // @dl:disable -- Bun projection allowlists (declarative key lists)
    private static let pageInfoKeep = ["page", "totalPages", "hasNextPage", "hasPreviousPage", "totalItems"]
    private static let searchHitKeep = [
        "path", "title", "framework", "rootSlug", "kind", "sourceType", "abstract", "declaration", "platforms",
        "language", "snippet", "relatedCount"
    ]
    private static let metadataKeep = [
        "title", "framework", "rootSlug", "roleHeading", "kind", "abstract", "declaration", "path", "platforms",
        "relationships"
    ]
    private static let flags = ["isDeprecated", "isBeta", "isReleaseNotes"]
    // @dl:enable

    /// `pick(src, keys)`: copies present keys (including explicit `null`) in `keys` order.
    static func pick(_ source: JSONValue?, _ keys: [String]) -> Object {
        guard case .object(let object)? = source else { return [:] }
        var out: Object = [:]
        for key in keys { if let value = object[key] { out[key] = value } }
        return out
    }

    /// `flagIf`: emits `key: true` only when the source value is truthy.
    static func flag(_ out: inout Object, _ source: JSONValue?, _ keys: [String]) {
        guard case .object(let object)? = source else { return }
        for key in keys where object[key].map(isTruthy) == true { out[key] = .bool(true) }
    }

    public static func isTruthy(_ value: JSONValue) -> Bool {
        switch value {
            case .null: false
            case .bool(let flag): flag
            case .int(let number): number != 0
            case .number(let number): number != 0 && !number.isNaN
            case .string(let text): !text.isEmpty
            case .array, .object: true
        }
    }

    public static func member(_ value: JSONValue?, _ key: String) -> JSONValue? {
        guard case .object(let object)? = value else { return nil }
        return object[key]
    }

    static func pageInfo(_ value: JSONValue?) -> JSONValue? {
        let out = pick(value, pageInfoKeep)
        return out.isEmpty ? nil : .object(out)
    }

    /// `publicConfidence(matchQuality)`.
    public static func confidence(_ matchQuality: String?) -> String {
        guard let matchQuality else { return "partial" }
        if matchQuality == "exact" { return "exact" }
        if matchQuality == "fuzzy" || matchQuality.hasPrefix("relaxed") { return "approximate" }
        return "partial"
    }

    /// `projectSearchHit`.
    public static func searchHit(_ hit: JSONValue) -> JSONValue {
        guard case .object = hit else { return hit }
        var out = pick(hit, searchHitKeep)
        out["confidence"] = .string(confidence(member(hit, "matchQuality").flatMap(\.stringValue)))
        flag(&out, hit, flags)
        return .object(out)
    }

    /// `projectSearchResult` (a `read=true` document payload dispatches to ``readDoc(_:full:)``).
    public static func searchResult(_ result: JSONValue, full: Bool = false) -> JSONValue {
        guard case .object(let object) = result else { return result }
        if object["found"] != nil, !(object["results"].map { if case .array = $0 { true } else { false } } ?? false) {
            return readDoc(result, full: full)
        }
        let hits: [JSONValue] = if case .array(let items)? = object["results"] { items.map(searchHit) } else { [] }
        var out: Object = ["query": object["query"].flatMap(\.stringValue).map(JSONValue.string) ?? .string("")]
        if case .int(let total)? = object["total"] { out["total"] = .int(total) } else { out["total"] = .int(0) }
        if case .bool(let hasMore)? = object["hasMore"] { out["hasMore"] = .bool(hasMore) }
        out["results"] = .array(hits)
        if hits.contains(where: { member($0, "confidence")?.stringValue == "approximate" }) {
            out["approximate"] = .bool(true)
        }
        if object["partial"].map(isTruthy) == true { out["truncated"] = .bool(true) }
        if let info = pageInfo(object["pageInfo"]) { out["pageInfo"] = info }
        return .object(out)
    }

    /// `projectReadDoc`; `full` keeps section text instead of `{heading, chars}` skeletons.
    public static func readDoc(_ payload: JSONValue, full: Bool) -> JSONValue {
        guard case .object(let object) = payload else { return payload }
        if case .bool(false)? = object["found"] {
            if let note = object["note"], isTruthy(note) { return .object(["found": .bool(false), "note": note]) }
            return .object(["found": .bool(false)])
        }
        var out: Object = ["found": .bool(true)]
        if let metadata = object["metadata"], isTruthy(metadata) {
            var projected = pick(metadata, metadataKeep)
            flag(&projected, metadata, flags)
            out["metadata"] = .object(projected)
        }
        if let content = object["content"] { out["content"] = content }
        if case .array(let sections)? = object["sections"] {
            out["sections"] = .array(sections.map { full ? sectionFull($0) : sectionSkeleton($0) })
        }
        if let matches = object["matches"] { out["matches"] = matches }
        if let note = object["note"] { out["note"] = note }
        if let best = object["bestMatch"], isTruthy(best) { out["bestMatch"] = searchHit(best) }
        if let info = pageInfo(object["pageInfo"]) { out["pageInfo"] = info }
        return .object(out)
    }

    private static func sectionSkeleton(_ section: JSONValue) -> JSONValue {
        guard case .object(let object) = section else { return section }
        if object["heading"] != nil, case .int(let chars)? = object["chars"] {
            return .object(["heading": object["heading"] ?? .null, "chars": .int(chars)])
        }
        let text = object["contentText"]?.stringValue ?? ""
        return .object(["heading": object["heading"] ?? .null, "chars": .int(Int64(text.utf16.count))])
    }

    private static func sectionFull(_ section: JSONValue) -> JSONValue {
        guard case .object(let object) = section else { return section }
        var out: Object = [:]
        if let heading = object["heading"] { out["heading"] = heading }
        if let text = object["contentText"] { out["contentText"] = text }
        return .object(out)
    }
}

extension JSONValue {
    var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }
}

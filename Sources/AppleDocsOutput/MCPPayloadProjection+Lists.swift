public import AemiJSONCore
import OrderedCollections

/// List-shaped tool projections: frameworks, browse, taxonomy, and asset tools.
extension MCPPayloadProjection {
    /// `projectFrameworks`.
    public static func frameworks(_ result: JSONValue) -> JSONValue {
        guard case .object(let object) = result else { return result }
        var out: Object = [:]
        if case .int(let total)? = object["total"] { out["total"] = .int(total) } else { out["total"] = .int(0) }
        out["roots"] = .array(pickEach(object["roots"], ["slug", "name", "kind", "pageCount"]) ?? [])
        if let info = pageInfo(object["pageInfo"]) { out["pageInfo"] = info }
        return .object(out)
    }

    /// `projectBrowse`.
    public static func browse(_ result: JSONValue) -> JSONValue {
        guard case .object(let object) = result else { return result }
        var out = pick(result, ["framework", "title", "path"])
        if case .int(let year)? = object["year"] { out["year"] = .int(year) }
        for (field, keys, hasTotal) in [
            ("groups", ["year", "count"], true), ("pages", ["path", "title", "kind", "abstract"], true),
            ("children", ["path", "title", "kind", "section"], false)
        ] {
            guard let items = pickEach(object[field], keys) else { continue }
            out[field] = .array(items)
            if hasTotal, let total = object["total"] { out["total"] = total }
        }
        if let info = pageInfo(object["pageInfo"]) { out["pageInfo"] = info }
        return .object(out)
    }

    /// Each element of an array member reduced to `keys`; `nil` when the member is not an array.
    static func pickEach(_ value: JSONValue?, _ keys: [String]) -> [JSONValue]? {
        guard case .array(let items)? = value else { return nil }
        return items.map { .object(pick($0, keys)) }
    }

    /// `projectTaxonomy`: `{field, values}` → `{[field]: entries}`; broad results keep the five fields.
    public static func taxonomy(_ result: JSONValue) -> JSONValue {
        guard case .object(let object) = result else { return result }
        func entries(_ value: JSONValue?) -> JSONValue {
            guard case .array(let items)? = value else { return .array([]) }
            return .array(
                items.map { item in
                    .object(["value": member(item, "value") ?? .null, "count": member(item, "count") ?? .int(0)])
                }
            )
        }
        if let field = object["field"]?.stringValue, case .array? = object["values"] {
            return .object([field: entries(object["values"])])
        }
        var out: Object = [:]
        for field in ["kind", "role", "docKind", "roleHeading", "sourceType"] {
            if case .array? = object[field] { out[field] = entries(object[field]) }
        }
        return .object(out)
    }

    /// `projectSearchSfSymbols`.
    public static func sfSymbols(_ result: JSONValue) -> JSONValue {
        let results: [JSONValue] =
            if case .array(let items)? = member(result, "results") {
                items.map { .object(pick($0, ["name", "scope"])) }
            } else { [] }
        return .object(["results": .array(results)])
    }

    /// `projectListAppleFonts`.
    public static func appleFonts(_ result: JSONValue) -> JSONValue {
        guard case .array(let families)? = member(result, "families") else { return .object(["families": .array([])]) }
        return .object([
            "families": .array(
                families.map { family in
                    var out: Object = ["id": member(family, "id") ?? .null]
                    if let name = member(family, "name") { out["name"] = name }
                    let files: [JSONValue] =
                        if case .array(let items)? = member(family, "files") {
                            items.map {
                                .object(["id": member($0, "id") ?? .null, "file_name": member($0, "file_name") ?? .null]
                                )
                            }
                        } else { [] }
                    out["files"] = .array(files)
                    return .object(out)
                }
            )
        ])
    }
}

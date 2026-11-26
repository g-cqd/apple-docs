import AemiJSONCore
import OrderedCollections

/// DocC reference resolution — a port of Bun's `normalize/refs.js`: identifier → corpus key, link-section
/// projection for `content_json`, link-section plain text, and reference decoration of content nodes
/// (`_resolvedTitle` / `_resolvedKey`) so renderers never re-resolve.
enum DocCReferences {
    /// `resolveRefKey(id, refs)`: the reference URL normalized (relative, then cross-source absolute), else the
    /// identifier itself normalized.
    static func resolveKey(_ identifier: String, refs: JSON) -> String? {
        if let url = refs[identifier]["url"].string, !url.isEmpty {
            if let key = AppleIdentifier.normalize(url) { return key }
            if let key = CrossSourceLinkMapper.key(forURL: url) { return key }
        }
        return AppleIdentifier.normalize(identifier)
    }

    /// `renderLinkSectionsToText`: group titles and item titles, newline-separated (`nil` when empty).
    static func linkSectionsText(_ sections: JSON, refs: JSON) -> String? {
        var lines: [String] = []
        for section in sections.array ?? [] {
            if let title = section["title"].string, !title.isEmpty { lines.append(title) }
            for id in (section["identifiers"].array ?? []).compactMap(\.string) {
                let title = DocCPlainText.referenceTitle(id, refs: refs)
                if !title.isEmpty { lines.append(title) }
            }
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// `normalizeLinkSections`: `[{title, type, items: [{identifier, key, title}]}]`.
    static func normalizedLinkSections(_ sections: JSON, refs: JSON) -> JSONValue {
        .array(
            (sections.array ?? [])
                .map { section in
                    let items: [JSONValue] = (section["identifiers"].array ?? []).compactMap(\.string)
                        .map { id in
                            JSONValue.makeObject {
                                ("identifier", .string(id))
                                ("key", optional(resolveKey(id, refs: refs)))
                                ("title", .string(DocCPlainText.referenceTitle(id, refs: refs)))
                            }
                        }
                    return JSONValue.makeObject {
                        ("title", optional(section["title"].string))
                        ("type", optional(section["type"].string))
                        ("items", .array(items))
                    }
                }
        )
    }

    /// `resolveContentReferences(nodes, refs)`: a copy of `nodes` with references decorated.
    static func resolvedContent(_ nodes: JSON, refs: JSON) -> JSONValue {
        guard nodes.isArray else { return JSONValue(nodes) }
        return resolved(JSONValue(nodes), refs: refs, depth: 0, isList: true)
    }

    static func optional(_ value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }

    private static func resolved(_ value: JSONValue, refs: JSON, depth: Int, isList: Bool) -> JSONValue {
        guard depth <= DocCPlainText.maxDepth else { return value }
        if isList, case .array(let items) = value {
            return .array(items.map { resolved($0, refs: refs, depth: depth + 1, isList: false) })
        }
        guard case .object(var node) = value else { return value }
        let type = node["type"].flatMap(\.stringValue)
        if type == "reference", let id = node["identifier"].flatMap(\.stringValue) {
            node["_resolvedTitle"] = optional(refs[id]["title"].string ?? node["title"].flatMap(\.stringValue))
            node["_resolvedKey"] = optional(resolveKey(id, refs: refs))
            return .object(node)
        }
        if type == "links", case .array(let items)? = node["items"] {
            node["items"] = .array(
                items.map { item in
                    guard case .string(let id) = item else { return item }
                    return JSONValue.makeObject {
                        ("identifier", .string(id))
                        ("_resolvedTitle", optional(refs[id]["title"].string))
                        ("_resolvedKey", optional(resolveKey(id, refs: refs)))
                    }
                }
            )
            return .object(node)
        }
        if type == "link", let destination = node["destination"].flatMap(\.stringValue),
            let key = CrossSourceLinkMapper.key(forURL: destination)
        {
            node["_resolvedKey"] = .string(key)
            return .object(node)
        }
        return .object(resolvedChildren(node, refs: refs, depth: depth, isTermList: type == "termList"))
    }

    private static func resolvedChildren(
        _ node: OrderedJSONObject,
        refs: JSON,
        depth: Int,
        isTermList: Bool
    ) -> OrderedJSONObject {
        var node = node
        for field in ["inlineContent", "content"] {
            if let child = node[field], case .array = child {
                node[field] = resolved(child, refs: refs, depth: depth + 1, isList: true)
            }
        }
        guard case .array(let items)? = node["items"] else { return node }
        node["items"] = .array(
            items.map { item in
                guard case .object(var entry) = item else { return item }
                // Bun only rewrites array content (`resolveContentReferences` returns non-arrays untouched).
                if let content = entry["content"], case .array = content {
                    entry["content"] = resolved(content, refs: refs, depth: depth + 1, isList: true)
                }
                if isTermList {
                    for (field, child) in [("term", "inlineContent"), ("definition", "content")] {
                        guard case .object(var nested)? = entry[field], let nodes = nested[child] else { continue }
                        nested[child] = resolved(nodes, refs: refs, depth: depth + 1, isList: true)
                        entry[field] = .object(nested)
                    }
                }
                return .object(entry)
            }
        )
        return node
    }
}

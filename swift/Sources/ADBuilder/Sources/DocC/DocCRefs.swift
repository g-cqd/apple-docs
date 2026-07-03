// DocC reference resolution (port of src/content/normalize/refs.js): the link-section
// projections used for topics/relationships/seeAlso `contentJson` + `contentText`, and the
// deep content-node reference decoration (`_resolvedTitle` / `_resolvedKey` injection) used
// for the discussion `contentJson`.
//
// Every projection is built as an `ADJSONCore.JSONValue` so it re-serializes to byte-for-byte
// `JSON.stringify` output. The JS spread `{ ...node, _resolvedKey }` (append the new key at the
// object's end, keeping the original member order) is reproduced by appending to an ordered
// key/value list; a reassignment of an existing key (`clone.inlineContent = …`) keeps its
// original position, reproduced by replacing that key in place while iterating.

import ADBase
import ADJSONCore

extension DocC {
    // MARK: - link sections (topics / relationships / seeAlso)

    /// `renderLinkSectionsToText(sections, refs)` — the section title then each referenced doc's
    /// title, newline-joined; `nil` when nothing renders. Used for the section `contentText`.
    static func renderLinkSectionsText(_ sections: JSON, _ ctx: DocCContext) -> String? {
        var lines: [String] = []
        sections.forEachElement { section in
            guard section.isObject else { return }
            let title = section["title"]
            if title.isTruthy { lines.append(title.jsString) }
            section["identifiers"].forEachElement { idNode in
                let text = linkTitleText(idNode, ctx)
                if !text.isEmpty { lines.append(text) }
            }
        }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// `ref?.title ?? normalizeIdentifier(id) ?? id` coerced to text (the render path).
    private static func linkTitleText(_ idNode: JSON, _ ctx: DocCContext) -> String {
        let id = idNode.string
        if let ref = ctx.lookup(id) {
            let title = ref["title"]
            if title.exists, !title.isNull { return title.jsString }
        }
        if let id, let norm = Identifier.normalize(id) { return norm }
        return id ?? idNode.jsString
    }

    /// `normalizeLinkSections(sections, refs, mapKey)` — the `[{ title, type, items:[{ identifier,
    /// key, title }] }]` projection stored as `contentJson`.
    static func normalizeLinkSections(_ sections: JSON, _ ctx: DocCContext) -> JSONValue {
        var out: [JSONValue] = []
        sections.forEachElement { section in
            guard section.isObject else {
                out.append(object([("title", .null), ("type", .null), ("items", .array([]))]))
                return
            }
            var items: [JSONValue] = []
            section["identifiers"].forEachElement { idNode in
                items.append(linkItem(idNode, ctx))
            }
            out.append(
                object([
                    ("title", valueOr(section["title"], .null)),
                    ("type", valueOr(section["type"], .null)),
                    ("items", .array(items)),
                ]))
        }
        return .array(out)
    }

    /// One `{ identifier, key, title }` link item (`title` = `ref?.title ?? normalizeIdentifier(id) ?? id`).
    private static func linkItem(_ idNode: JSON, _ ctx: DocCContext) -> JSONValue {
        let id = idNode.string
        let ref = ctx.lookup(id)
        let title = ctx.refTitleValue(ref) ?? normalizedIdValue(id, idNode)
        return object([
            ("identifier", JSONValue(idNode)),
            ("key", ctx.resolvedKeyValue(id)),
            ("title", title),
        ])
    }

    /// `normalizeIdentifier(id) ?? id` as a value.
    private static func normalizedIdValue(_ id: String?, _ idNode: JSON) -> JSONValue {
        if let id, let norm = Identifier.normalize(id) { return .string(norm) }
        return JSONValue(idNode)
    }

    // MARK: - content-node reference decoration (discussion contentJson)

    /// `resolveContentReferences(nodes, refs, mapKey)` — deep-clone the content nodes, decorating
    /// reference / links / link nodes with resolved titles + keys. A non-array passes through.
    static func resolveContentNodes(_ nodes: JSON, _ ctx: DocCContext) -> JSONValue {
        guard nodes.isArray else { return JSONValue(nodes) }
        var out: [JSONValue] = []
        out.reserveCapacity(nodes.count)
        nodes.forEachElement { out.append(resolveNode($0, ctx)) }
        return .array(out)
    }

    /// `resolveContentReferences(nodes ?? [], refs, mapKey)` — the `?? []` coalescing form: an
    /// absent/null node resolves to `[]` (used by properties/REST/possibleValues/discussion).
    static func resolveContentNodesOr(_ nodes: JSON, _ ctx: DocCContext) -> JSONValue {
        guard nodes.exists, !nodes.isNull else { return .array([]) }
        return resolveContentNodes(nodes, ctx)
    }

    private static func mapNodes(_ nodes: JSON, _ ctx: DocCContext) -> JSONValue {
        var out: [JSONValue] = []
        out.reserveCapacity(nodes.count)
        nodes.forEachElement { out.append(resolveNode($0, ctx)) }
        return .array(out)
    }

    /// `resolveNodeRefs(node, refs, mapKey)` — the per-node dispatch.
    private static func resolveNode(_ node: JSON, _ ctx: DocCContext) -> JSONValue {
        guard node.isObject else { return JSONValue(node) }
        let type = node["type"].string
        if type == "reference" { return resolveReferenceNode(node, ctx) }
        if type == "links", node["items"].isArray { return resolveLinksNode(node, ctx) }
        if type == "link", let dest = node["destination"].string,
            let key = resolveLinkDestination(dest, ctx)
        {
            return DocC.appendMembers(node, [("_resolvedKey", .string(key))])
        }
        return resolveGeneralNode(node, type, ctx)
    }

    /// A `reference` inline node: `{ ...node, _resolvedTitle, _resolvedKey }`.
    private static func resolveReferenceNode(_ node: JSON, _ ctx: DocCContext) -> JSONValue {
        let id = node["identifier"].string
        let title = ctx.refTitleValue(ctx.lookup(id)) ?? presentValue(node["title"]) ?? .null
        return appendMembers(node, [("_resolvedTitle", title), ("_resolvedKey", ctx.resolvedKeyValue(id))])
    }

    /// A `links` block node: replace the `items` id array with resolved `{ identifier, _resolvedTitle,
    /// _resolvedKey }` objects, in place.
    private static func resolveLinksNode(_ node: JSON, _ ctx: DocCContext) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        node.forEachMember { key, value in
            if key == "items" {
                var items: [JSONValue] = []
                value.forEachElement { idNode in
                    let id = idNode.string
                    items.append(
                        object([
                            ("identifier", JSONValue(idNode)),
                            ("_resolvedTitle", ctx.refTitleValue(ctx.lookup(id)) ?? .null),
                            ("_resolvedKey", ctx.resolvedKeyValue(id)),
                        ]))
                }
                pairs.append(("items", .array(items)))
            } else {
                pairs.append((key, JSONValue(value)))
            }
        }
        return object(pairs)
    }

    /// `mapUrlToKey(destination)` then `mapKey`, non-empty — the inline-`link` `_resolvedKey`.
    private static func resolveLinkDestination(_ dest: String, _ ctx: DocCContext) -> String? {
        guard let candidate = LinkResolver.mapUrlToKey(dest) else { return nil }
        let key = ctx.keyMapper(candidate)
        return key.isEmpty ? nil : key
    }

    /// The general (recurse-into-children) branch: `inlineContent` / `content` arrays recurse; `items`
    /// arrays get the generic (item.content) or termList (term/definition) treatment.
    private static func resolveGeneralNode(_ node: JSON, _ type: String?, _ ctx: DocCContext) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        node.forEachMember { key, value in
            if (key == "inlineContent" || key == "content"), value.isArray {
                pairs.append((key, mapNodes(value, ctx)))
            } else if key == "items", value.isArray {
                let mapped = type == "termList" ? mapTermListItems(value, ctx) : mapGenericItems(value, ctx)
                pairs.append((key, .array(mapped)))
            } else {
                pairs.append((key, JSONValue(value)))
            }
        }
        return object(pairs)
    }

    /// `items.map(item => item?.content ? { ...item, content: item.content.map(resolveNodeRefs) } : item)`.
    private static func mapGenericItems(_ items: JSON, _ ctx: DocCContext) -> [JSONValue] {
        var out: [JSONValue] = []
        items.forEachElement { item in
            if item.isObject, item["content"].isArray {
                out.append(rebuildReplacing(item, "content", ctx))
            } else {
                out.append(JSONValue(item))
            }
        }
        return out
    }

    /// The termList branch: resolve `term.inlineContent` and `definition.content` in place.
    private static func mapTermListItems(_ items: JSON, _ ctx: DocCContext) -> [JSONValue] {
        var out: [JSONValue] = []
        items.forEachElement { item in
            guard item.isObject else { out.append(JSONValue(item)); return }
            var pairs: [(String, JSONValue)] = []
            item.forEachMember { key, value in
                if key == "term", value.isObject, value["inlineContent"].isArray {
                    pairs.append((key, rebuildReplacing(value, "inlineContent", ctx)))
                } else if key == "definition", value.isObject, value["content"].isArray {
                    pairs.append((key, rebuildReplacing(value, "content", ctx)))
                } else {
                    pairs.append((key, JSONValue(value)))
                }
            }
            out.append(object(pairs))
        }
        return out
    }

    /// `{ ...obj, <childKey>: obj[childKey].map(resolveNodeRefs) }` — replace one array child in place.
    private static func rebuildReplacing(_ obj: JSON, _ childKey: String, _ ctx: DocCContext) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        obj.forEachMember { key, value in
            pairs.append((key, key == childKey ? mapNodes(value, ctx) : JSONValue(value)))
        }
        return object(pairs)
    }
}

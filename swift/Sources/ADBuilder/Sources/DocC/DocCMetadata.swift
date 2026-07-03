// DocC metadata extraction (port of src/content/normalize/metadata.js): kind / language /
// declaration-text / platform resolution, section lookup, heading extraction, and the token
// enrichment (`_resolvedKey` decoration) used by the declaration + properties + REST sections.

import ADBase
import ADJSONCore
import OrderedCollections

// Hoisted to file scope as typed `private let` so the enum bodies stay well under the 100ms
// type-check budget (a large dictionary literal inside a function is the classic budget-buster).

/// `resolveKind`'s role → kind map.
private let roleToKind: [String: String] = [
    "symbol": "symbol", "article": "article", "collectionGroup": "collection",
    "collection": "collection", "overview": "overview", "sampleCode": "sampleCode",
    "framework": "framework", "class": "class", "struct": "struct", "enum": "enum",
    "protocol": "protocol", "typealias": "typealias", "func": "func", "var": "var", "init": "init",
]

/// `resolvePlatforms`'s platform display-name → lowercase slug map.
private let platformNameToSlug: [String: String] = [
    "iOS": "ios", "macOS": "macos", "watchOS": "watchos", "tvOS": "tvos", "visionOS": "visionos",
    "Mac Catalyst": "maccatalyst", "macCatalyst": "maccatalyst", "iPadOS": "ipados",
]

extension DocC {
    /// `resolveKind(json)` — `metadata.symbolKind` if present, else the role mapped through the kind
    /// table, else the raw role, else nil.
    static func resolveKind(_ root: JSON) -> String? {
        let meta = root["metadata"]
        let symbolKind = meta["symbolKind"]
        if symbolKind.isTruthy { return symbolKind.jsString }
        let role = meta["role"]
        if let roleStr = role.string, let mapped = roleToKind[roleStr] { return mapped }
        return role.string
    }

    /// `resolveLanguage(json)` — explicit declaration languages first (swift, then occ), else the
    /// presence of a module name (Apple frameworks default to swift), else nil.
    static func resolveLanguage(_ root: JSON) -> String? {
        var result: String? = nil
        root["primaryContentSections"].forEachElement { section in
            guard result == nil, section.isObject,
                section["kind"].utf8Equals("declarations")
            else { return }
            section["declarations"].forEachElement { decl in
                guard result == nil else { return }
                let langs = decl["languages"]
                if arrayContains(langs, "swift") { result = "swift" } else if arrayContains(langs, "occ") {
                    result = "occ"
                }
            }
        }
        if let result { return result }
        let firstModule = root["metadata"]["modules"][index: 0]
        if firstModule.exists, firstModule.isObject, firstModule["name"].isTruthy { return "swift" }
        return nil
    }

    /// `resolveDeclarationText(json)` — the first declarations section whose first declaration has
    /// tokens: its token texts concatenated (`|| null` when empty).
    static func resolveDeclarationText(_ root: JSON) -> String? {
        var result: String? = nil
        var found = false
        root["primaryContentSections"].forEachElement { section in
            guard !found, section.isObject, section["kind"].utf8Equals("declarations") else { return }
            let decl = section["declarations"][index: 0]
            guard decl.exists, decl["tokens"].isTruthy else { return }
            found = true
            var text = ""
            decl["tokens"].forEachElement { token in
                let value = token["text"]
                if value.exists, !value.isNull { text += value.jsString }
            }
            result = text.isEmpty ? nil : text
        }
        return result
    }

    /// `resolvePlatforms(meta)` — `{ slug: introducedAt }` in first-occurrence order (dup slugs
    /// last-wins, first position, matching the JS map assignment).
    static func resolvePlatforms(_ meta: JSON) -> OrderedDictionary<String, JSONValue> {
        var map = OrderedDictionary<String, JSONValue>()
        meta["platforms"].forEachElement { platform in
            guard platform.isObject else { return }
            let introduced = platform["introducedAt"]
            guard introduced.isTruthy else { return }
            guard let slug = platformSlug(platform["name"]) else { return }
            map[slug] = JSONValue(introduced)
        }
        return map
    }

    /// `nameToKey[name] ?? name.toLowerCase() ?? null`, then the `if (slug)` truthiness gate.
    private static func platformSlug(_ nameNode: JSON) -> String? {
        guard let name = nameNode.string else { return nil }
        if let mapped = platformNameToSlug[name] { return mapped }
        let lower = name.lowercased()
        return lower.isEmpty ? nil : lower
    }

    /// The introduced-at version string for a platform slug (the `minIos`/`minMacos`/… document field).
    static func platformVersion(_ map: OrderedDictionary<String, JSONValue>, _ slug: String) -> String? {
        if case .string(let version) = map[slug] { return version }
        return nil
    }

    /// `findSection(sections, kind)` — the first section with a matching `kind`.
    static func firstSection(_ sections: JSON, kind: StaticString) -> JSON? {
        guard sections.isArray else { return nil }
        var result: JSON? = nil
        sections.forEachElement { section in
            guard result == nil, section.isObject, section["kind"].utf8Equals(kind) else { return }
            result = section
        }
        return result
    }

    /// `extractFirstHeading(nodes, refs)` — the first heading node's `text` (or rendered inline).
    static func extractFirstHeading(_ nodes: JSON, _ ctx: DocCContext) -> String? {
        guard nodes.isArray else { return nil }
        var result: String? = nil
        var found = false
        nodes.forEachElement { node in
            guard !found, node.isObject, node["type"].utf8Equals("heading") else { return }
            found = true
            let text = node["text"]
            if text.exists, !text.isNull {
                result = text.jsString
            } else {
                result = renderInlineText(node["inlineContent"], ctx)
            }
        }
        return result
    }

    /// `collectHeadings(json, refs)` — every heading text across the `content` primary sections,
    /// space-joined (an FTS hint), or nil.
    static func collectHeadings(_ root: JSON, _ ctx: DocCContext) -> String? {
        var texts: [String] = []
        root["primaryContentSections"].forEachElement { section in
            guard section.isObject, section["kind"].utf8Equals("content") else { return }
            section["content"].forEachElement { node in
                guard node.isObject, node["type"].utf8Equals("heading") else { return }
                let textNode = node["text"]
                let text =
                    (textNode.exists && !textNode.isNull)
                    ? textNode.jsString : renderInlineText(node["inlineContent"], ctx)
                if !text.isEmpty { texts.append(text) }
            }
        }
        return texts.isEmpty ? nil : texts.joined(separator: " ")
    }

    // MARK: - token enrichment

    /// `enrichDeclarationTokens(declarations, refs, mapKey)` — decorate typeIdentifier/attribute
    /// tokens with `_resolvedKey` (via identifier resolution, then a title→key fallback).
    static func enrichDeclarationTokens(_ node: JSON, _ ctx: DocCContext) -> JSONValue {
        guard node.exists, !node.isNull else { return .array([]) }  // `declarations ?? []`
        guard node.isArray, node.count > 0 else { return JSONValue(node) }
        let titleToKey = buildTitleToKey(ctx)
        var out: [JSONValue] = []
        node.forEachElement { decl in
            let tokens = decl["tokens"]
            guard tokens.isArray else { out.append(JSONValue(decl)); return }
            var enriched: [JSONValue] = []
            tokens.forEachElement { token in enriched.append(enrichDeclToken(token, titleToKey, ctx)) }
            out.append(replaceMember(decl, "tokens", .array(enriched)))
        }
        return .array(out)
    }

    private static func enrichDeclToken(
        _ token: JSON, _ titleToKey: [String: String], _ ctx: DocCContext
    ) -> JSONValue {
        let kind = token["kind"]
        guard kind.utf8Equals("typeIdentifier") || kind.utf8Equals("attribute") else {
            return JSONValue(token)
        }
        let identifier = token["identifier"]
        if identifier.isTruthy, let key = ctx.mapKey(ctx.resolveRefKey(identifier.string)) {
            return appendMembers(token, [("_resolvedKey", .string(key))])
        }
        let text = token["text"]
        if text.isTruthy, let textStr = text.string, let mapped = titleToKey[textStr] {
            return appendMembers(token, [("_resolvedKey", .string(mapped))])
        }
        return JSONValue(token)
    }

    /// Build the reference title → canonical key lookup (type-like `doc://` refs only).
    private static func buildTitleToKey(_ ctx: DocCContext) -> [String: String] {
        var titleToKey: [String: String] = [:]
        guard ctx.references.isObject else { return titleToKey }
        ctx.references.forEachMember { id, ref in
            guard id.hasPrefix("doc://"), ref.isObject else { return }
            guard let url = ref["url"].string, !url.isEmpty else { return }
            guard let key = Identifier.normalize(url) else { return }
            guard let title = ref["title"].string, !title.isEmpty, !title.contains("(") else {
                return
            }
            titleToKey[title] = ctx.keyMapper(key)
        }
        return titleToKey
    }

    /// `enrichTypeTokens(tokens ?? [], refs, mapKey)` — decorate typeIdentifier tokens with
    /// `_resolvedKey`. `tokens` is the raw `item.type` node; absent/null coalesces to `[]`.
    static func enrichTypeTokens(_ node: JSON, _ ctx: DocCContext) -> JSONValue {
        guard node.exists, !node.isNull else { return .array([]) }
        guard node.isArray, node.count > 0 else { return JSONValue(node) }
        var out: [JSONValue] = []
        node.forEachElement { token in
            guard token["kind"].utf8Equals("typeIdentifier") else {
                out.append(JSONValue(token))
                return
            }
            let identifier = token["identifier"]
            if identifier.isTruthy, let key = ctx.mapKey(ctx.resolveRefKey(identifier.string)) {
                out.append(appendMembers(token, [("_resolvedKey", .string(key))]))
            } else {
                out.append(JSONValue(token))
            }
        }
        return .array(out)
    }

    /// Whether a JSON array contains the given string literal.
    private static func arrayContains(_ array: JSON, _ literal: StaticString) -> Bool {
        guard array.isArray else { return false }
        var found = false
        array.forEachElement { if $0.utf8Equals(literal) { found = true } }
        return found
    }
}

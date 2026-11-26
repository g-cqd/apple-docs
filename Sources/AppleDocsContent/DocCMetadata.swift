import AemiJSONCore
import OrderedCollections

/// Document-level metadata helpers — a port of Bun's `normalize/metadata.js` (kind, language, declaration
/// text, platforms, headings, and declaration/type token enrichment with `_resolvedKey`).
enum DocCMetadata {
    /// Bun's `resolveKind` role map (`collectionGroup` → `collection`; other roles verbatim).
    private static func kind(forRole role: String) -> String {
        role == "collectionGroup" ? "collection" : role
    }

    /// Bun's `resolvePlatforms` name map; unknown names are lowercased.
    private static func platformKey(_ name: String) -> String {
        switch name {
            case "Mac Catalyst", "macCatalyst": "maccatalyst"
            default: name.lowercased()
        }
    }

    /// `resolveKind`: `symbolKind`, else the role mapped (or verbatim).
    static func kind(_ root: JSON) -> String? {
        let meta = root["metadata"]
        if let symbolKind = meta["symbolKind"].string, !symbolKind.isEmpty { return symbolKind }
        guard let role = meta["role"].string else { return nil }
        return kind(forRole: role)
    }

    /// `resolveLanguage`: `swift`/`occ` from declaration languages, else `swift` when a module is named.
    static func language(_ root: JSON) -> String? {
        for section in root["primaryContentSections"].array ?? [] where section["kind"].string == "declarations" {
            for declaration in section["declarations"].array ?? [] {
                let languages = (declaration["languages"].array ?? []).compactMap(\.string)
                if languages.contains("swift") { return "swift" }
                if languages.contains("occ") { return "occ" }
            }
        }
        if let module = root["metadata"]["modules"][index: 0]["name"].string, !module.isEmpty { return "swift" }
        return nil
    }

    /// `resolveDeclarationText`: the first declarations section's first declaration tokens, joined.
    static func declarationText(_ root: JSON) -> String? {
        for section in root["primaryContentSections"].array ?? [] where section["kind"].string == "declarations" {
            let tokens = section["declarations"][index: 0]["tokens"]
            guard let items = tokens.array else { continue }
            let text = items.map { $0["text"].string ?? "" }.joined()
            return text.isEmpty ? nil : text
        }
        return nil
    }

    /// `resolvePlatforms`: lowercase platform slug → `introducedAt` (later entries win).
    static func platforms(_ meta: JSON) -> OrderedDictionary<String, String> {
        var map: OrderedDictionary<String, String> = [:]
        for platform in meta["platforms"].array ?? [] {
            guard let introduced = platform["introducedAt"].string, !introduced.isEmpty,
                let name = platform["name"].string
            else { continue }
            map[platformKey(name)] = introduced
        }
        return map
    }

    /// `findSection`: the first primary content section of `kind`.
    static func section(_ root: JSON, kind: String) -> JSON? {
        (root["primaryContentSections"].array ?? []).first { $0["kind"].string == kind }
    }

    /// `extractFirstHeading`.
    static func firstHeading(_ nodes: JSON, refs: JSON) -> String? {
        for node in nodes.array ?? [] where node["type"].string == "heading" {
            return node["text"].string ?? DocCPlainText.inline(node["inlineContent"], refs: refs)
        }
        return nil
    }

    /// `collectHeadings`: every heading text across `content` sections, space-joined.
    static func headings(_ root: JSON, refs: JSON) -> String? {
        var texts: [String] = []
        for section in root["primaryContentSections"].array ?? [] where section["kind"].string == "content" {
            for node in section["content"].array ?? [] where node["type"].string == "heading" {
                let text = node["text"].string ?? DocCPlainText.inline(node["inlineContent"], refs: refs)
                if !text.isEmpty { texts.append(text) }
            }
        }
        return texts.isEmpty ? nil : texts.joined(separator: " ")
    }

    /// `enrichDeclarationTokens`: `typeIdentifier` / `attribute` tokens gain `_resolvedKey` from their
    /// identifier, else from a reference whose (parenthesis-free) title equals the token text.
    static func enrichedDeclarations(
        _ declarations: JSON,
        refs: JSON,
        keyMapper: ((String) -> String)? = nil
    ) -> JSONValue {
        guard let items = declarations.array, !items.isEmpty else { return JSONValue(declarations) }
        var titleToKey: [String: String] = [:]
        refs.forEachMember { id, ref in
            guard id.hasPrefix("doc://"), let url = ref["url"].string, let key = AppleIdentifier.normalize(url),
                let title = ref["title"].string, !title.isEmpty, !title.contains("(")
            else { return }
            titleToKey[title] = keyMapper?(key) ?? key
        }
        return .array(
            items.map { declaration in
                guard case .object(var object) = JSONValue(declaration), case .array(let tokens)? = object["tokens"]
                else { return JSONValue(declaration) }
                object["tokens"] = .array(
                    tokens.map {
                        enrich(
                            $0,
                            kinds: ["typeIdentifier", "attribute"],
                            refs: refs,
                            titles: titleToKey,
                            keyMapper: keyMapper
                        )
                    }
                )
                return .object(object)
            }
        )
    }

    /// `enrichTypeTokens`: `typeIdentifier` tokens gain `_resolvedKey` from their identifier.
    static func enrichedTypeTokens(
        _ tokens: JSON,
        refs: JSON,
        keyMapper: ((String) -> String)? = nil
    ) -> JSONValue {
        guard let items = tokens.array, !items.isEmpty else { return tokens.exists ? JSONValue(tokens) : .array([]) }
        return .array(
            items.map {
                enrich(JSONValue($0), kinds: ["typeIdentifier"], refs: refs, titles: [:], keyMapper: keyMapper)
            }
        )
    }

    private static func enrich(
        _ token: JSONValue,
        kinds: Set<String>,
        refs: JSON,
        titles: [String: String],
        keyMapper: ((String) -> String)?
    ) -> JSONValue {
        guard case .object(var object) = token, let kind = object["kind"]?.stringValue, kinds.contains(kind) else {
            return token
        }
        if let id = object["identifier"]?.stringValue, !id.isEmpty,
            let key = DocCReferences.resolveKey(id, refs: refs, keyMapper: keyMapper)
        {
            object["_resolvedKey"] = .string(key)
            return .object(object)
        }
        if let text = object["text"]?.stringValue, let key = titles[text] {
            object["_resolvedKey"] = .string(key)
            return .object(object)
        }
        return token
    }
}

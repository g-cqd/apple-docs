// DocC outbound-reference extraction (port of src/apple/extractor.js `extractReferences`) — the
// BFS seed-expansion primitive: every documentation path a DocC page links to (topics /
// relationships / seeAlso identifiers + the body's cross-reference sweep), deduplicated in
// first-seen order (JS `Set` insertion order). Resolution here is deliberately SIMPLER than the
// normalizer's `resolveRefKey` (no cross-source URL map): a reference's `url` via
// `normalizeIdentifier`, else the identifier itself — externally-resolved symbols (no DocC page)
// and Apple's abstract-less ghost entries are dropped.

import ADBase
public import ADJSONCore

extension DocC {
    /// Identifiers under this authority are symbols from other modules (Swift stdlib, …). Apple
    /// renders a link but serves no DocC JSON page for them, so they must not seed the crawl.
    static let externalIdPrefix = "doc://com.externally.resolved.symbol/"

    /// `extractReferences(json)` — the deduplicated outbound documentation paths (first-seen order).
    public static func extractReferences(_ root: JSON) -> [String] {
        let references = root["references"]
        let index = DocCContext(references: references, keyMapper: { $0 })

        var ordered: [String] = []
        var seen = Set<String>()
        func add(_ value: String?) {
            if let value, seen.insert(value).inserted { ordered.append(value) }
        }

        // topicSections / relationshipsSections / seeAlsoSections identifiers, in that order.
        for field in ["topicSections", "relationshipsSections", "seeAlsoSections"] {
            root[field].forEachElement { section in
                section["identifiers"].forEachElement { add(resolve($0.string, index)) }
            }
        }

        // Body cross-reference sweep: `type == 'topic'` refs with a `/documentation/` URL and a
        // non-empty abstract (Apple's ghost duplicates carry an empty abstract — skip them).
        references.forEachMember { id, ref in
            guard !id.hasPrefix(externalIdPrefix), ref["type"].utf8Equals("topic") else { return }
            guard let url = ref["url"].string, url.contains("/documentation/") else { return }
            let abstract = ref["abstract"]
            guard abstract.isArray, abstract.count > 0 else { return }
            add(Identifier.normalize(url))
        }

        return ordered
    }

    /// Parse raw DocC JSON bytes then extract references (`[]` on a parse failure).
    public static func extractReferences(jsonBytes bytes: [UInt8]) -> [String] {
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512)) else {
            return []
        }
        return extractReferences(document.root)
    }

    /// `resolve(id)` — external symbols → nil; else the reference `url` via `normalizeIdentifier`,
    /// else the identifier itself. (No cross-source URL map — this is the crawl-seed resolution.)
    private static func resolve(_ id: String?, _ index: DocCContext) -> String? {
        guard let id else { return nil }
        if id.hasPrefix(externalIdPrefix) { return nil }
        if let ref = index.lookup(id), let url = ref["url"].string, !url.isEmpty,
            let norm = Identifier.normalize(url)
        {
            return norm
        }
        return Identifier.normalize(id)
    }
}

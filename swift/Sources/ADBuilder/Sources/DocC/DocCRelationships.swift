// DocC relationships extraction (port of src/content/normalize/relationships.js): topicSections →
// `child`, relationshipsSections → inheritance/conformance (typed), seeAlsoSections → `see_also`.
// One shared `sortOrder` counter runs across all three passes, matching the JS.

import ADJSONCore

/// `RELATION_TYPE_MAP` — the relationshipsSections `type` → canonical relation type.
private let relationTypeMap: [String: String] = [
    "inheritsFrom": "inherits_from", "conformsTo": "conforms_to", "inheritedBy": "inherited_by"
]

extension DocC {
    /// `extractDocCRelationships(json, key, refs, mapKey)` → the `{ fromKey, toKey, relationType,
    /// section, sortOrder }` records.
    static func extractRelationships(_ root: JSON, key: String, _ ctx: DocCContext)
        -> [NormalizedRelationship]
    {
        var relationships: [NormalizedRelationship] = []
        var order = 0

        func append(_ sections: JSON, relationType: (JSON) -> String) {
            sections.forEachElement { section in
                guard section.isObject else { return }
                let type = relationType(section)
                let sectionTitle = section["title"].string
                section["identifiers"]
                    .forEachElement { idNode in
                        guard let toKey = ctx.mapKey(ctx.resolveRefKey(idNode.string)), !toKey.isEmpty
                        else { return }
                        relationships.append(
                            NormalizedRelationship(
                                fromKey: key, toKey: toKey, relationType: type, section: sectionTitle,
                                sortOrder: order))
                        order += 1
                    }
            }
        }

        append(root["topicSections"]) { _ in "child" }
        append(root["relationshipsSections"]) { section in
            let type = section["type"].string
            if let type, let mapped = relationTypeMap[type] { return mapped }
            return type ?? "related"
        }
        append(root["seeAlsoSections"]) { _ in "see_also" }

        return relationships
    }
}

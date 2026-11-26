import AemiJSONCore
public import AppleDocsCore
import Foundation

/// Parses Apple DocC JSON render nodes (`metadata`, `abstract`, `primaryContentSections`,
/// `topicSections`, `relationshipsSections`, `seeAlsoSections`, `references`, `platforms`, `identifier`)
/// into normalized ``ConvertedDocument`` values via `g-cqd/AemiJSON`'s zero-copy tape parser.
///
/// Section kinds and ordering follow the Bun corpus model (see ``DocCSectionExtractor``) so imported
/// v31 corpora and freshly crawled Swift corpora render and search identically.
public enum DocCJSONConverter: Sendable {
    private static let externalIDPrefix = "doc://com.externally.resolved.symbol/"

    /// Converts raw DocC JSON UTF-8 `bytes` into a normalized ``ConvertedDocument`` with sections & relationships.
    public static func convert(
        json bytes: [UInt8],
        key: DocumentKey,
        sourceType: SourceKind = .appleDocC,
        url: String? = nil
    ) throws -> ConvertedDocument {
        let root = try AemiJSON.parse(bytes).root
        let refs = root["references"]
        let metadata = root["metadata"]
        let extraction = DocCSectionExtractor.extract(from: root, refs: refs)
        let abstractText = DocCContentRenderer.renderInline(root["abstract"], refs: refs)
        let flags = parsePlatformFlags(metadata["platforms"])
        let headings = extraction.sections
            .filter { $0.sectionKind == "discussion" }
            .compactMap(\.heading)
            .joined(separator: "\n")

        let document = DocumentRecord(
            key: key,
            sourceType: sourceType,
            title: metadata["title"].string ?? key.rawValue,
            kind: metadata["symbolKind"].string ?? root["kind"].string,
            role: metadata["role"].string,
            roleHeading: metadata["roleHeading"].string,
            framework: key.rootSlug,
            url: url,
            language: root["identifier"]["interfaceLanguage"].string,
            usr: metadata["externalID"].string,
            abstractText: abstractText.isEmpty ? nil : abstractText,
            declarationText: extraction.declaration,
            headings: headings.isEmpty ? nil : headings,
            availability: parsePlatforms(metadata["platforms"]),
            isDeprecated: flags.deprecated,
            isBeta: flags.beta,
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1)
        )
        let relationships = extractRelationships(from: root, refs: refs, sourceKey: key)
        return ConvertedDocument(
            document: document,
            sections: extraction.sections,
            relationships: relationships,
            discoveredKeys: discoverKeys(relationships: relationships, refs: refs, sourceKey: key)
        )
    }

    /// Normalizes a DocC URL or `doc://` identifier into a canonical ``DocumentKey``, if valid.
    public static func normalizeReferenceKey(_ raw: String) -> DocumentKey? {
        guard !raw.hasPrefix(externalIDPrefix) else { return nil }
        let trimmed: String
        if let range = raw.range(of: "/documentation/") {
            trimmed = String(raw[range.upperBound...])
        } else if let range = raw.range(of: "/design/human-interface-guidelines/") {
            trimmed = "design/human-interface-guidelines/" + String(raw[range.upperBound...])
        } else {
            return nil
        }
        let withoutFragment = trimmed.split(separator: "#", maxSplits: 1).first.map(String.init) ?? trimmed
        let cleaned = withoutFragment.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !cleaned.isEmpty else { return nil }
        return try? DocumentKey(cleaned)
    }

    private static func extractRelationships(
        from root: JSON,
        refs: JSON,
        sourceKey: DocumentKey
    ) -> [DocumentRelationshipRecord] {
        var edges: [DocumentRelationshipRecord] = []
        var indexByEdge: [String: Int] = [:]
        var order = 0
        // Bun `normalize/relationships.js` relation types: topics are `child`, see-also groups `see_also`, and
        // relationship groups keep their DocC type with inheritance/conformance mapped to snake case.
        let groupsByType: [(JSON, String?)] = [
            (root["topicSections"], "child"),
            (root["relationshipsSections"], nil),
            (root["seeAlsoSections"], "see_also")
        ]
        for (sectionsNode, fixedType) in groupsByType {
            for group in sectionsNode.array ?? [] {
                let kind = fixedType ?? Self.relationType(forDocCType: group["type"].string)
                for id in (group["identifiers"].array ?? []).compactMap(\.string) where !id.hasPrefix(externalIDPrefix)
                {
                    let candidate = refs[id]["url"].string ?? id
                    guard let target = normalizeReferenceKey(candidate), target != sourceKey else { continue }
                    let edge = DocumentRelationshipRecord(
                        fromKey: sourceKey,
                        toKey: target,
                        relationType: kind,
                        section: group["title"].string,
                        sortOrder: order
                    )
                    order += 1
                    // Bun upserts on (from, to, type): a repeated edge keeps its last section and order.
                    if let index = indexByEdge["\(target.rawValue)|\(kind)"] {
                        edges[index] = edge
                    } else {
                        indexByEdge["\(target.rawValue)|\(kind)"] = edges.count
                        edges.append(edge)
                    }
                }
            }
        }
        return edges
    }

    /// Bun's `RELATION_TYPE_MAP` for `relationshipsSections` group types.
    private static func relationType(forDocCType type: String?) -> String {
        switch type {
            case "inheritsFrom": "inherits_from"
            case "conformsTo": "conforms_to"
            case "inheritedBy": "inherited_by"
            case let other?: other
            case nil: "related"
        }
    }

    /// Structured relationship targets plus Bun's catch-all sweep of the `references` map: inline `topic`
    /// references under `/documentation/` that carry a non-empty abstract (empty-abstract entries are Apple's
    /// stale duplicates whose data files 404).
    private static func discoverKeys(
        relationships: [DocumentRelationshipRecord],
        refs: JSON,
        sourceKey: DocumentKey
    ) -> [DocumentKey] {
        var seen = Set(relationships.map(\.toKey.rawValue))
        var keys = relationships.map(\.toKey)
        guard let entries = refs.object else { return keys }
        for (id, ref) in entries where !id.hasPrefix(externalIDPrefix) {
            guard ref["type"].string == "topic", let url = ref["url"].string, url.contains("/documentation/"),
                let abstract = ref["abstract"].array, !abstract.isEmpty,
                let key = normalizeReferenceKey(url), key != sourceKey, seen.insert(key.rawValue).inserted
            else {
                continue
            }
            keys.append(key)
        }
        return keys
    }

    private static func parsePlatforms(_ node: JSON) -> PlatformAvailability {
        var versions: [String: String] = [:]
        for item in node.array ?? [] {
            guard let name = item["name"].string?.lowercased(), let introduced = item["introducedAt"].string else {
                continue
            }
            let canonical = name == "ipados" ? "ios" : name
            if versions[canonical] == nil { versions[canonical] = introduced }
        }
        return PlatformAvailability(
            ios: versions["ios"],
            macos: versions["macos"],
            watchos: versions["watchos"],
            tvos: versions["tvos"],
            visionos: versions["visionos"]
        )
    }

    private static func parsePlatformFlags(_ node: JSON) -> (deprecated: Bool, beta: Bool) {
        guard let items = node.array, !items.isEmpty else { return (false, false) }
        let anyDeprecated = items.contains { $0["deprecated"].bool == true || $0["deprecatedAt"].string != nil }
        let anyBeta = items.contains { $0["beta"].bool == true }
        return (anyDeprecated, anyBeta)
    }
}

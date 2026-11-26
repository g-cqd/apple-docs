import AemiJSONCore
public import AppleDocsCore
import Foundation
import OrderedCollections

/// Parses Apple DocC JSON render nodes (`metadata`, `abstract`, `primaryContentSections`,
/// `topicSections`, `relationshipsSections`, `seeAlsoSections`, `references`, `platforms`, `identifier`)
/// into normalized ``ConvertedDocument`` values via `g-cqd/AemiJSON`'s zero-copy tape parser.
///
/// Section kinds and ordering follow the Bun corpus model (see ``DocCSectionExtractor``) so imported
/// v31 corpora and freshly crawled Swift corpora render and search identically.
public enum DocCJSONConverter: Sendable {
    private static let externalIDPrefix = "doc://com.externally.resolved.symbol/"

    /// Converts raw DocC JSON UTF-8 `bytes` into a normalized ``ConvertedDocument`` with sections & relationships,
    /// field-for-field identical to Bun's `normalize/docc.js` (verified by golden-file tests).
    ///
    /// - Parameters:
    ///   - bytes: the DocC render JSON.
    ///   - key: the page's corpus key.
    ///   - sourceType: the source the page belongs to.
    ///   - url: the page URL for sources whose URL is not derived from the key (Swift-DocC books); Apple DocC and
    ///     HIG pages always use `https://developer.apple.com/[documentation/]<key>`.
    ///   - keyMapper: optional key-rewriting closure for external/Swift-DocC archives.
    /// - Returns: the document, its sections and relationships, and the keys it links to.
    /// - Throws: when `bytes` is not valid JSON.
    public static func convert(
        json bytes: [UInt8],
        key: DocumentKey,
        sourceType: SourceKind = .appleDocC,
        url: String? = nil,
        keyMapper: (@Sendable (String) -> String)? = nil
    ) throws -> ConvertedDocument {
        let root = try AemiJSON.parse(bytes).root
        let refs = root["references"]
        let metadata = root["metadata"]
        let platforms = DocCMetadata.platforms(metadata)
        let role = metadata["role"].string
        let document = DocumentRecord(
            key: key,
            sourceType: sourceType,
            title: metadata["title"].string ?? key.rawValue,
            kind: DocCMetadata.kind(root),
            role: role,
            roleHeading: metadata["roleHeading"].string,
            framework: key.rootSlug,
            url: pageURL(key: key, sourceType: sourceType, fallback: url),
            language: DocCMetadata.language(root),
            usr: metadata["externalID"].string,
            abstractText: root["abstract"].isArray ? DocCPlainText.inline(root["abstract"], refs: refs) : nil,
            declarationText: DocCMetadata.declarationText(root),
            headings: DocCMetadata.headings(root, refs: refs),
            availability: PlatformAvailability(
                ios: platforms["ios"],
                macos: platforms["macos"],
                watchos: platforms["watchos"],
                tvos: platforms["tvos"],
                visionos: platforms["visionos"]
            ),
            platformsJSON: platforms.isEmpty
                ? nil : JSONValue.object(platforms.mapValues(JSONValue.string)).jsonText,
            isDeprecated: metadata["deprecated"].bool == true,
            isBeta: metadata["beta"].bool == true,
            isReleaseNotes: key.rawValue.contains("release-notes") || role == "releaseNotes",
            urlDepth: key.rawValue.split(separator: "/", omittingEmptySubsequences: false).count - 1
        )
        let relationships = extractRelationships(from: root, refs: refs, sourceKey: key, keyMapper: keyMapper)
        return ConvertedDocument(
            document: document,
            sections: DocCSectionNormalizer.sections(root: root, refs: refs, keyMapper: keyMapper),
            relationships: relationships,
            discoveredKeys: discoverKeys(
                relationships: relationships,
                refs: refs,
                sourceKey: key,
                keyMapper: keyMapper
            )
        )
    }

    /// Bun's page URL rule: HIG (`design/...`) pages live at the site root, everything else under `/documentation/`.
    static func pageURL(key: DocumentKey, sourceType: SourceKind, fallback: String?) -> String? {
        guard sourceType == .appleDocC || sourceType == .hig else { return fallback }
        if sourceType == .hig || key.rawValue.hasPrefix("design/") {
            return "https://developer.apple.com/\(key.rawValue)"
        }
        return "https://developer.apple.com/documentation/\(key.rawValue)"
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

    /// Bun `normalize/relationships.js`: topics → `child`, relationship groups → mapped type, see-also →
    /// `see_also`; targets resolved with `resolveRefKey`; a repeated (target, type) edge keeps its last
    /// section and order, matching Bun's upsert.
    private static func extractRelationships(
        from root: JSON,
        refs: JSON,
        sourceKey: DocumentKey,
        keyMapper: ((String) -> String)?
    ) -> [DocumentRelationshipRecord] {
        var edges: [DocumentRelationshipRecord] = []
        var indexByEdge: [String: Int] = [:]
        var order = 0
        let groupsByType: [(JSON, String?)] = [
            (root["topicSections"], "child"),
            (root["relationshipsSections"], nil),
            (root["seeAlsoSections"], "see_also")
        ]
        for (sectionsNode, fixedType) in groupsByType {
            for group in sectionsNode.array ?? [] {
                let kind = fixedType ?? Self.relationType(forDocCType: group["type"].string)
                for id in (group["identifiers"].array ?? []).compactMap(\.string) {
                    guard let resolved = DocCReferences.resolveKey(id, refs: refs, keyMapper: keyMapper),
                        let target = try? DocumentKey(resolved)
                    else { continue }
                    let edge = DocumentRelationshipRecord(
                        fromKey: sourceKey,
                        toKey: target,
                        relationType: kind,
                        section: group["title"].string,
                        sortOrder: order
                    )
                    order += 1
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
        sourceKey: DocumentKey,
        keyMapper: ((String) -> String)?
    ) -> [DocumentKey] {
        var seen = Set(relationships.map(\.toKey.rawValue))
        var keys = relationships.map(\.toKey).filter { $0 != sourceKey }
        guard let entries = refs.object else { return keys }
        for (id, ref) in entries where !id.hasPrefix(externalIDPrefix) {
            guard ref["type"].string == "topic", let url = ref["url"].string, url.contains("/documentation/"),
                let abstract = ref["abstract"].array, !abstract.isEmpty,
                let rawKey = normalizeReferenceKey(url),
                let key = keyMapper.flatMap({ try? DocumentKey($0(rawKey.rawValue)) }) ?? rawKey as DocumentKey?,
                key != sourceKey, seen.insert(key.rawValue).inserted
            else {
                continue
            }
            keys.append(key)
        }
        return keys
    }
}

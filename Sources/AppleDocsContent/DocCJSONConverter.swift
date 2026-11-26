import AemiJSONCore
public import AppleDocsCore
import Foundation

/// Parses Apple DocC JSON render nodes (`metadata`, `abstract`, `primaryContentSections`,
/// `topicSections`, `relationshipsSections`, `seeAlsoSections`, `references`, `platforms`, `identifier`)
/// into normalized ``ConvertedDocument`` values via `g-cqd/AemiJSON`'s zero-copy tape parser.
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
        let metadata = root["metadata"]
        let title = metadata["title"].string ?? key.rawValue
        let roleHeading = metadata["roleHeading"].string
        let role = metadata["role"].string
        let symbolKind = metadata["symbolKind"].string ?? root["kind"].string
        let language = root["identifier"]["interfaceLanguage"].string
        let usr = metadata["externalID"].string
        let abstractText = flattenInlineText(root["abstract"])
        let availability = parsePlatforms(metadata["platforms"])
        let flags = parsePlatformFlags(metadata["platforms"])
        let (declarationText, sections) = parsePrimarySections(root["primaryContentSections"])
        let relationships = extractRelationships(from: root, sourceKey: key)

        let headings = sections.compactMap(\.heading).filter { !$0.isEmpty }.joined(separator: "\n")
        let document = DocumentRecord(
            key: key,
            sourceType: sourceType,
            title: title,
            kind: symbolKind,
            role: role,
            roleHeading: roleHeading,
            framework: key.rootSlug,
            url: url,
            language: language,
            usr: usr,
            abstractText: abstractText.isEmpty ? nil : abstractText,
            declarationText: declarationText,
            headings: headings.isEmpty ? nil : headings,
            availability: availability,
            isDeprecated: flags.deprecated,
            isBeta: flags.beta,
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1)
        )
        return ConvertedDocument(document: document, sections: sections, relationships: relationships)
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
        let cleaned = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !cleaned.isEmpty else { return nil }
        return try? DocumentKey(cleaned)
    }

    private static func extractRelationships(from root: JSON, sourceKey: DocumentKey) -> [DocumentRelationshipRecord] {
        let refs = root["references"]
        var edges: [DocumentRelationshipRecord] = []
        var seen: Set<String> = []

        func appendGroup(_ sectionsNode: JSON, relationType: String) {
            guard let groups = sectionsNode.array else { return }
            for group in groups {
                let groupTitle = group["title"].string
                let kind = group["type"].string ?? relationType
                guard let ids = group["identifiers"].array else { continue }
                for idNode in ids {
                    guard let id = idNode.string, !id.hasPrefix(externalIDPrefix) else { continue }
                    let candidate = refs[id]["url"].string ?? id
                    guard let targetKey = normalizeReferenceKey(candidate), targetKey != sourceKey else { continue }
                    let dedup = "\(targetKey.rawValue)|\(kind)"
                    guard seen.insert(dedup).inserted else { continue }
                    edges.append(
                        DocumentRelationshipRecord(
                            fromKey: sourceKey,
                            toKey: targetKey,
                            relationType: kind,
                            section: groupTitle,
                            sortOrder: edges.count
                        )
                    )
                }
            }
        }

        appendGroup(root["topicSections"], relationType: "topic")
        appendGroup(root["relationshipsSections"], relationType: "relationship")
        appendGroup(root["seeAlsoSections"], relationType: "see-also")
        return edges
    }

    private static func parsePlatforms(_ node: JSON) -> PlatformAvailability {
        guard let items = node.array else { return .none }
        var ios: String?
        var macos: String?
        var watchos: String?
        var tvos: String?
        var visionos: String?
        for item in items {
            guard let name = item["name"].string?.lowercased(), let introduced = item["introducedAt"].string else {
                continue
            }
            switch name {
                case "ios", "ipados": ios = ios ?? introduced
                case "macos": macos = macos ?? introduced
                case "watchos": watchos = watchos ?? introduced
                case "tvos": tvos = tvos ?? introduced
                case "visionos": visionos = visionos ?? introduced
                default: continue
            }
        }
        return PlatformAvailability(ios: ios, macos: macos, watchos: watchos, tvos: tvos, visionos: visionos)
    }

    private static func parsePlatformFlags(_ node: JSON) -> (deprecated: Bool, beta: Bool) {
        guard let items = node.array, !items.isEmpty else { return (false, false) }
        let anyDeprecated = items.contains { $0["deprecated"].bool == true || $0["deprecatedAt"].string != nil }
        let anyBeta = items.contains { $0["beta"].bool == true }
        return (anyDeprecated, anyBeta)
    }

    private static func parsePrimarySections(_ node: JSON) -> (String?, [DocumentSectionRecord]) {
        guard let items = node.array else { return (nil, []) }
        var declaration: String?
        var sections: [DocumentSectionRecord] = []
        for item in items {
            let kind = item["kind"].string ?? "content"
            if kind == "declarations", declaration == nil {
                declaration = extractDeclaration(item["declarations"])
            } else if kind == "parameters", let params = item["parameters"].array {
                let lines = params.compactMap { param -> String? in
                    guard let name = param["name"].string else { return nil }
                    let desc = extractContentSections(param["content"].array ?? [], startingOrder: 0)
                        .map(\.contentText)
                        .joined(separator: " ")
                    return "- `\(name)`: \(desc)"
                }
                if !lines.isEmpty {
                    sections.append(
                        DocumentSectionRecord(
                            sectionKind: "parameters",
                            heading: "Parameters",
                            contentText: lines.joined(separator: "\n"),
                            sortOrder: sections.count
                        )
                    )
                }
            } else if kind == "content", let blocks = item["content"].array {
                sections.append(contentsOf: extractContentSections(blocks, startingOrder: sections.count))
            }
        }
        return (declaration, sections)
    }

    private static func extractDeclaration(_ declarations: JSON) -> String? {
        guard let first = declarations.array?.first, let tokens = first["tokens"].array else { return nil }
        let joined = tokens.compactMap { $0["text"].string }.joined()
        return joined.isEmpty ? nil : joined
    }

    private static func extractContentSections(_ blocks: [JSON], startingOrder: Int) -> [DocumentSectionRecord] {
        var builder = ConvertedDocument.SectionBuilder(startingOrder: startingOrder)
        for block in blocks {
            switch block["type"].string ?? "" {
                case "heading":
                    builder.startSection(heading: block["text"].string)
                case "paragraph":
                    builder.appendBlock(flattenInlineText(block["inlineContent"]))
                case "aside":
                    let style = (block["style"].string ?? "note").capitalized
                    let inner = extractContentSections(block["content"].array ?? [], startingOrder: 0)
                        .map(\.contentText)
                        .joined(separator: "\n")
                    if !inner.isEmpty { builder.appendBlock("> **\(style):** \(inner)") }
                case "codeListing":
                    let syntax = block["syntax"].string ?? ""
                    let code = (block["code"].array ?? []).compactMap(\.string).joined(separator: "\n")
                    if !code.isEmpty { builder.appendBlock("```\(syntax)\n\(code)\n```") }
                default:
                    continue
            }
        }
        return builder.finish()
    }

    private static func flattenInlineText(_ node: JSON) -> String {
        guard let items = node.array else { return "" }
        var parts: [String] = []
        for item in items {
            switch item["type"].string ?? "" {
                case "text":
                    if let text = item["text"].string { parts.append(text) }
                case "codeVoice":
                    if let code = item["code"].string { parts.append("`\(code)`") }
                case "reference":
                    if let title = item["overridingTitle"].string ?? item["identifier"].string {
                        parts.append(title)
                    }
                default:
                    continue
            }
        }
        return parts.joined()
    }
}

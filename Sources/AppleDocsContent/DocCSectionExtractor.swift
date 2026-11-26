import AemiJSONCore
import AppleDocsCore
import Foundation

/// Extracts the ordered section list of a DocC render node with the same section kinds and ordering as the
/// Bun `normalize/docc.js` model: `abstract`, `declaration`, `parameters`, `properties`, `rest_endpoint`,
/// `rest_parameters`, `rest_responses`, `possible_values`, `mentioned_in`, one `discussion` per content block
/// (plus unknown primary kinds that carry content), then `topics`, `relationships`, and `see_also`.
enum DocCSectionExtractor {
    /// Ordered sections plus the flattened declaration text (also stored on the document row).
    struct Extraction {
        var sections: [DocumentSectionRecord] = []
        var declaration: String?

        mutating func append(kind: String, heading: String?, text: String) {
            guard !text.isEmpty else { return }
            sections.append(
                DocumentSectionRecord(sectionKind: kind, heading: heading, contentText: text, sortOrder: sections.count)
            )
        }
    }

    private static let handledPrimaryKinds: Set<String> = [
        "declarations", "parameters", "content", "properties", "restEndpoint",
        "restParameters", "restResponses", "possibleValues", "mentions"
    ]

    static func extract(from root: JSON, refs: JSON) -> Extraction {
        var result = Extraction()
        result.append(
            kind: "abstract",
            heading: nil,
            text: DocCContentRenderer.renderInline(root["abstract"], refs: refs)
        )

        let primary = root["primaryContentSections"].array ?? []
        appendDeclaration(primary, into: &result)
        for spec in listSpecs {
            appendList(spec, primary: primary, into: &result, refs: refs)
        }
        appendContent(primary, into: &result, refs: refs)

        appendLinkGroups(root["topicSections"], kind: "topics", heading: "Topics", into: &result, refs: refs)
        appendLinkGroups(
            root["relationshipsSections"],
            kind: "relationships",
            heading: "Relationships",
            into: &result,
            refs: refs
        )
        appendLinkGroups(root["seeAlsoSections"], kind: "see_also", heading: "See Also", into: &result, refs: refs)
        return result
    }

    private static func appendDeclaration(_ primary: [JSON], into result: inout Extraction) {
        guard let section = primary.first(where: { $0["kind"].string == "declarations" }),
            let tokens = section["declarations"].array?.first?["tokens"].array
        else {
            return
        }
        let text = tokens.compactMap { $0["text"].string }.joined()
        guard !text.isEmpty else { return }
        result.declaration = text
        result.append(kind: "declaration", heading: "Declaration", text: "```swift\n\(text)\n```")
    }

    /// Declarative description of a list-shaped primary content section (one line per item).
    private struct ListSpec: Sendable {
        let primaryKind: String
        let sectionKind: String
        let defaultHeading: String
        let listKey: String
        let separator: String
        let allowsMultiple: Bool
        let line: @Sendable (JSON, JSON) -> String?

        init(
            _ kinds: (primary: String, section: String),
            heading: String,
            listKey: String,
            separator: String = "\n",
            allowsMultiple: Bool = false,
            line: @escaping @Sendable (JSON, JSON) -> String? = DocCSectionExtractor.namedItemLine
        ) {
            self.primaryKind = kinds.primary
            self.sectionKind = kinds.section
            self.defaultHeading = heading
            self.listKey = listKey
            self.separator = separator
            self.allowsMultiple = allowsMultiple
            self.line = line
        }
    }

    /// List-shaped primary sections in Bun corpus order.
    // @dl:disable -- declarative spec table: rows intentionally share one constructor shape
    private static let listSpecs: [ListSpec] = [
        ListSpec(("parameters", "parameters"), heading: "Parameters", listKey: "parameters"),
        ListSpec(("properties", "properties"), heading: "Properties", listKey: "items"),
        ListSpec(
            ("restEndpoint", "rest_endpoint"),
            heading: "URL",
            listKey: "tokens",
            separator: "",
            allowsMultiple: true
        ) { token, _ in
            token["text"].string
        },
        ListSpec(("restParameters", "rest_parameters"), heading: "Parameters", listKey: "items", allowsMultiple: true),
        ListSpec(("restResponses", "rest_responses"), heading: "Response Codes", listKey: "items", line: responseLine),
        ListSpec(("possibleValues", "possible_values"), heading: "Possible Values", listKey: "values"),
        ListSpec(("mentions", "mentioned_in"), heading: "Mentioned in", listKey: "mentions") { id, refs in
            id.string.map { "- \(DocCContentRenderer.referenceTitle($0, refs: refs))" }
        }
    ]

    // @dl:enable

    private static func appendList(_ spec: ListSpec, primary: [JSON], into result: inout Extraction, refs: JSON) {
        for section in primary where section["kind"].string == spec.primaryKind {
            let lines = (section[spec.listKey].array ?? []).compactMap { spec.line($0, refs) }
            result.append(
                kind: spec.sectionKind,
                heading: section["title"].string ?? spec.defaultHeading,
                text: lines.joined(separator: spec.separator)
            )
            if !spec.allowsMultiple { return }
        }
    }

    static func namedItemLine(_ item: JSON, refs: JSON) -> String? {
        guard let name = item["name"].string else { return nil }
        let desc = DocCContentRenderer.renderBlocks(item["content"].array ?? [], refs: refs)
            .replacing("\n\n", with: " ")
        return desc.isEmpty ? "- `\(name)`" : "- `\(name)`: \(desc)"
    }

    private static func responseLine(_ item: JSON, refs: JSON) -> String? {
        let status = item["status"].int.map(String.init) ?? ""
        let reason = item["reason"].string ?? ""
        let desc = DocCContentRenderer.renderBlocks(item["content"].array ?? [], refs: refs)
        return "- \(status) \(reason): \(desc)".trimmingCharacters(in: .whitespaces)
    }

    private static func appendContent(_ primary: [JSON], into result: inout Extraction, refs: JSON) {
        for section in primary {
            let kind = section["kind"].string ?? ""
            let isContent = kind == "content"
            guard isContent || !handledPrimaryKinds.contains(kind), let nodes = section["content"].array,
                !nodes.isEmpty
            else {
                continue
            }
            let firstHeading = DocCContentRenderer.firstHeading(nodes, refs: refs)
            let heading = isContent ? (firstHeading ?? "Overview") : (section["title"].string ?? firstHeading ?? kind)
            let text = DocCContentRenderer.renderBlocks(nodes, refs: refs, skippingFirstHeading: firstHeading != nil)
            result.append(kind: "discussion", heading: heading, text: text)
        }
    }

    private static func appendLinkGroups(
        _ groups: JSON,
        kind: String,
        heading: String,
        into result: inout Extraction,
        refs: JSON
    ) {
        guard let items = groups.array, !items.isEmpty else { return }
        var blocks: [String] = []
        for group in items {
            let titles = (group["identifiers"].array ?? []).compactMap(\.string)
                .map { "- \(DocCContentRenderer.referenceTitle($0, refs: refs))" }
            // Bun keeps a titled group even when it lists no identifiers (e.g. generated See Also groups).
            let lines = (group["title"].string.map { ["#### \($0)"] } ?? []) + titles
            guard !lines.isEmpty else { continue }
            blocks.append(lines.joined(separator: "\n"))
        }
        result.append(kind: kind, heading: heading, text: blocks.joined(separator: "\n\n"))
    }
}

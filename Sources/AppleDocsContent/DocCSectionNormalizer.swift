import AemiJSONCore
import AppleDocsCore
import OrderedCollections

/// Builds a page's stored sections exactly like Bun's `normalize/docc.js`: Bun section kinds and order,
/// reserved slots (`abstract` 0, `declaration` 1, `parameters` 2, `properties` 3, kept even when absent),
/// plain-text `content_text` for search, and structured `content_json` (references decorated) for rendering.
struct DocCSectionNormalizer {
    let root: JSON
    let refs: JSON
    let keyMapper: ((String) -> String)?
    private(set) var sections: [DocumentSectionRecord] = []
    private var order = 0

    static let handledPrimaryKinds: Set<String> = [
        "declarations", "parameters", "content", "properties", "restEndpoint", "restParameters", "restResponses",
        "possibleValues", "mentions"
    ]

    static func sections(
        root: JSON,
        refs: JSON,
        keyMapper: ((String) -> String)? = nil
    ) -> [DocumentSectionRecord] {
        var builder = DocCSectionNormalizer(root: root, refs: refs, keyMapper: keyMapper)
        builder.build()
        return builder.sections
    }

    private mutating func build() {
        appendAbstract()
        appendDeclaration()
        appendParameters()
        appendProperties()
        appendRestEndpoints()
        appendRestParameters()
        appendRestResponses()
        appendPossibleValues()
        appendMentions()
        appendContent()
        appendLinkSections("topicSections", kind: "topics", heading: "Topics")
        appendLinkSections("relationshipsSections", kind: "relationships", heading: "Relationships")
        appendLinkSections("seeAlsoSections", kind: "see_also", heading: "See Also")
    }

    /// Appends a section at the next slot; a `nil` text is stored empty (Bun stores `NULL`).
    mutating func append(_ kind: String, heading: String?, text: String?, json: JSONValue) {
        sections.append(
            DocumentSectionRecord(
                sectionKind: kind,
                heading: heading,
                contentText: text ?? "",
                contentJSON: json.jsonText,
                sortOrder: order
            )
        )
        order += 1
    }

    /// Keeps a reserved slot when its section is absent.
    mutating func skipSlot() {
        order += 1
    }

    private mutating func appendAbstract() {
        guard let nodes = root["abstract"].array, !nodes.isEmpty else { return skipSlot() }
        append(
            "abstract",
            heading: nil,
            text: DocCPlainText.inline(root["abstract"], refs: refs),
            json: JSONValue(root["abstract"])
        )
    }

    private mutating func appendDeclaration() {
        guard let section = DocCMetadata.section(root, kind: "declarations") else { return skipSlot() }
        let declarations = section["declarations"]
        let enriched =
            declarations.exists && !declarations.isNull
            ? DocCMetadata.enrichedDeclarations(declarations, refs: refs, keyMapper: keyMapper) : .array([])
        var text = ""
        if case .array(let items) = enriched, case .object(let first)? = items.first,
            case .array(let tokens)? = first["tokens"]
        {
            text =
                tokens.map { token in
                    if case .object(let object) = token { return object["text"]?.stringValue ?? "" }
                    return ""
                }
                .joined()
        }
        append("declaration", heading: "Declaration", text: text.isEmpty ? nil : text, json: enriched)
    }

    private mutating func appendParameters() {
        guard let section = DocCMetadata.section(root, kind: "parameters"),
            let parameters = section["parameters"].array,
            !parameters.isEmpty
        else { return skipSlot() }
        let text = parameters.map { namedLine(name: $0["name"], content: $0["content"]) }.joined(separator: "\n")
        append(
            "parameters",
            heading: "Parameters",
            text: text.isEmpty ? nil : text,
            json: JSONValue(section["parameters"])
        )
    }

    private mutating func appendMentions() {
        guard let section = DocCMetadata.section(root, kind: "mentions"), let mentions = section["mentions"].array,
            !mentions.isEmpty
        else { return }
        var titles: [String] = []
        let items: [JSONValue] = mentions.map { mention in
            let id = mention.string ?? ""
            let title = DocCPlainText.referenceTitle(id, refs: refs)
            titles.append(title)
            return JSONValue.makeObject {
                ("identifier", JSONValue(mention))
                ("key", DocCReferences.optional(DocCReferences.resolveKey(id, refs: refs, keyMapper: keyMapper)))
                ("title", .string(title))
            }
        }
        let text = titles.joined(separator: "\n")
        append("mentioned_in", heading: "Mentioned in", text: text.isEmpty ? nil : text, json: .array(items))
    }

    private mutating func appendContent() {
        let primary = root["primaryContentSections"].array ?? []
        for section in primary where section["kind"].string == "content" {
            let nodes = section["content"]
            appendDiscussion(nodes, heading: DocCMetadata.firstHeading(nodes, refs: refs) ?? "Overview")
        }
        for section in primary where !Self.handledPrimaryKinds.contains(section["kind"].string ?? "") {
            guard let nodes = section["content"].array, !nodes.isEmpty else { continue }
            let heading =
                section["title"].string ?? DocCMetadata.firstHeading(section["content"], refs: refs)
                ?? section["kind"].string ?? "Section"
            appendDiscussion(section["content"], heading: heading)
        }
    }

    private mutating func appendDiscussion(_ nodes: JSON, heading: String) {
        let text = DocCPlainText.blocks(nodes, refs: refs)
        append(
            "discussion",
            heading: heading,
            text: text.isEmpty ? nil : text,
            json: nodes.isArray
                ? DocCReferences.resolvedContent(nodes, refs: refs, keyMapper: keyMapper) : .array([])
        )
    }

    private mutating func appendLinkSections(_ field: String, kind: String, heading: String) {
        guard let groups = root[field].array, !groups.isEmpty else { return }
        append(
            kind,
            heading: heading,
            text: DocCReferences.linkSectionsText(root[field], refs: refs),
            json: DocCReferences.normalizedLinkSections(root[field], refs: refs, keyMapper: keyMapper)
        )
    }

    /// `${name ?? ''}: ${desc}`.trim() with the description rendered as plain text.
    func namedLine(name: JSON, content: JSON) -> String {
        let description = content.exists && !content.isNull ? DocCPlainText.blocks(content, refs: refs) : ""
        return DocCPlainText.trimmed("\(name.string ?? ""): \(description)")
    }
}

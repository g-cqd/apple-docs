import AemiJSONCore
import OrderedCollections

/// Item-list sections: properties, REST endpoint/parameters/responses, and possible values.
extension DocCSectionNormalizer {
    /// How one item-list primary section is projected (Bun `normalize/docc.js` steps 4–8).
    private struct ItemSpec {
        let primaryKind: String
        let sectionKind: String
        let listKey: String
        let defaultHeading: String
        /// Bun keeps every section of the kind (REST parameters) or only the first.
        let allowsMultiple: Bool
        /// Bun reserves a sort slot for the kind even when absent (properties).
        let reservesSlot: Bool
        let fields: [String]
    }

    // @dl:disable -- declarative spec table: one row per Bun item-list section kind
    private static let itemSpecs: [ItemSpec] = [
        ItemSpec(
            primaryKind: "properties",
            sectionKind: "properties",
            listKey: "items",
            defaultHeading: "Properties",
            allowsMultiple: false,
            reservesSlot: true,
            fields: ["name", "type", "content", "required", "attributes", "introducedVersion"]
        ),
        ItemSpec(
            primaryKind: "restParameters",
            sectionKind: "rest_parameters",
            listKey: "items",
            defaultHeading: "Parameters",
            allowsMultiple: true,
            reservesSlot: false,
            fields: ["name", "type", "content", "required", "source", "attributes"]
        ),
        ItemSpec(
            primaryKind: "restResponses",
            sectionKind: "rest_responses",
            listKey: "items",
            defaultHeading: "Response Codes",
            allowsMultiple: false,
            reservesSlot: false,
            fields: ["status", "reason", "mimeType", "type", "content"]
        ),
        ItemSpec(
            primaryKind: "possibleValues",
            sectionKind: "possible_values",
            listKey: "values",
            defaultHeading: "Possible Values",
            allowsMultiple: false,
            reservesSlot: false,
            fields: ["name", "content"]
        )
    ]

    mutating func appendProperties() { appendItems(Self.itemSpecs[0]) }
    mutating func appendRestParameters() { appendItems(Self.itemSpecs[1]) }
    mutating func appendRestResponses() { appendItems(Self.itemSpecs[2]) }
    mutating func appendPossibleValues() { appendItems(Self.itemSpecs[3]) }

    mutating func appendRestEndpoints() {
        for section in root["primaryContentSections"].array ?? [] where section["kind"].string == "restEndpoint" {
            var text = ""
            let tokens: [JSONValue] = (section["tokens"].array ?? [])
                .map { token in
                    let tokenText = token["text"].string ?? ""
                    text += tokenText
                    return JSONValue.makeObject {
                        ("kind", .string(token["kind"].string ?? "text"))
                        ("text", .string(tokenText))
                    }
                }
            let heading = section["title"].string ?? "URL"
            append("rest_endpoint", heading: heading, text: text.isEmpty ? nil : text, json: .array(tokens))
        }
    }

    private mutating func appendItems(_ spec: ItemSpec) {
        var appended = false
        for section in root["primaryContentSections"].array ?? [] where section["kind"].string == spec.primaryKind {
            if appended && !spec.allowsMultiple { break }
            let items = section[spec.listKey].array ?? []
            // Single-section kinds require a non-empty list; REST parameter sections are kept even when empty.
            if items.isEmpty && !spec.allowsMultiple { break }
            let json: [JSONValue] = items.map { item in itemObject(item, section: section, fields: spec.fields) }
            let text = items.map { line(for: $0, spec: spec) }.joined(separator: "\n")
            append(
                spec.sectionKind,
                heading: section["title"].string ?? spec.defaultHeading,
                text: text.isEmpty ? nil : text,
                json: .array(json)
            )
            appended = true
        }
        if !appended && spec.reservesSlot { skipSlot() }
    }

    private func itemObject(_ item: JSON, section: JSON, fields: [String]) -> JSONValue {
        var object = OrderedJSONObject()
        for field in fields {
            switch field {
                case "type": object[field] = DocCMetadata.enrichedTypeTokens(item["type"], refs: refs)
                case "content": object[field] = resolvedContent(item["content"])
                case "required": object[field] = value(item["required"], or: .bool(false))
                case "attributes": object[field] = value(item["attributes"], or: .array([]))
                case "source": object[field] = value(section["source"])
                default: object[field] = value(item[field])
            }
        }
        return .object(object)
    }

    private func line(for item: JSON, spec: ItemSpec) -> String {
        guard spec.primaryKind == "restResponses" else {
            return namedLine(name: item["name"], content: item["content"])
        }
        let status = item["status"].int.map(String.init) ?? item["status"].string ?? ""
        let description = DocCPlainText.blocks(item["content"], refs: refs)
        return DocCPlainText.trimmed("\(status) \(item["reason"].string ?? ""): \(description)")
    }

    /// `value ?? fallback` with JavaScript nullish semantics.
    private func value(_ json: JSON, or fallback: JSONValue = .null) -> JSONValue {
        json.exists && !json.isNull ? JSONValue(json) : fallback
    }

    private func resolvedContent(_ json: JSON) -> JSONValue {
        json.isArray ? DocCReferences.resolvedContent(json, refs: refs) : value(json, or: .array([]))
    }
}

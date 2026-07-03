// DocC section builders (the per-kind arms of src/content/normalize/docc.js). Each returns the
// `NormalizedSection` for one section kind — `contentText` via the reused `ContentText`
// renderers, `contentJson` via a JS-`JSON.stringify`-parity `JSONValue`. Split from the
// orchestration in DocCNormalize.swift so both stay well under the type-check budget.

import ADBase
import ADJSONCore

extension DocC {
    /// The first declaration's token texts concatenated (`|| null` when empty) — the declaration
    /// section's `contentText`. Enrichment does not change token text, so the raw tokens are used.
    static func declarationTokensText(_ declarationSection: JSON) -> String? {
        let decl = declarationSection["declarations"][index: 0]
        guard decl.exists else { return nil }
        var text = ""
        decl["tokens"].forEachElement { token in
            let value = token["text"]
            if value.exists, !value.isNull { text += value.jsString }
        }
        return text.isEmpty ? nil : text
    }

    /// The `${name ?? ''}: ${desc}` per-item lines (parameters / properties / restParameters /
    /// possibleValues), trimmed and newline-joined (`|| null`).
    static func nameColonDescLines(_ items: JSON, _ ctx: DocCContext) -> String? {
        var lines: [String] = []
        items.forEachElement { item in
            let name = coerceOrEmpty(item["name"])
            let desc = descriptionText(item["content"], ctx)
            lines.append(trimJS("\(name): \(desc)"))
        }
        let joined = lines.joined(separator: "\n")
        return joined.isEmpty ? nil : joined
    }

    // MARK: - parameters

    static func parametersSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        NormalizedSection(
            sectionKind: "parameters", heading: "Parameters",
            contentText: nameColonDescLines(section["parameters"], ctx),
            contentJson: stringify(JSONValue(section["parameters"])), sortOrder: order)
    }

    // MARK: - properties

    static func propertiesSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        var items: [JSONValue] = []
        section["items"].forEachElement { items.append(propertyItem($0, ctx)) }
        return NormalizedSection(
            sectionKind: "properties",
            heading: strField(section["title"]) ?? "Properties",
            contentText: nameColonDescLines(section["items"], ctx),
            contentJson: stringify(.array(items)), sortOrder: order)
    }

    private static func propertyItem(_ item: JSON, _ ctx: DocCContext) -> JSONValue {
        object([
            ("name", valueOr(item["name"], .null)),
            ("type", enrichTypeTokens(item["type"], ctx)),
            ("content", resolveContentNodesOr(item["content"], ctx)),
            ("required", valueOr(item["required"], .bool(false))),
            ("attributes", valueOr(item["attributes"], .array([]))),
            ("introducedVersion", valueOr(item["introducedVersion"], .null)),
        ])
    }

    // MARK: - REST

    static func restEndpointSection(_ endpoint: JSON, order: Int) -> NormalizedSection {
        var tokens: [JSONValue] = []
        var text = ""
        endpoint["tokens"].forEachElement { token in
            tokens.append(
                object([
                    ("kind", valueOr(token["kind"], .string("text"))),
                    ("text", valueOr(token["text"], .string(""))),
                ]))
            text += coerceOrEmpty(token["text"])
        }
        return NormalizedSection(
            sectionKind: "rest_endpoint",
            heading: strField(endpoint["title"]) ?? "URL",
            contentText: text.isEmpty ? nil : text,
            contentJson: stringify(.array(tokens)), sortOrder: order)
    }

    static func restParametersSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        let source = valueOr(section["source"], .null)
        var items: [JSONValue] = []
        section["items"].forEachElement { items.append(restParamItem($0, source, ctx)) }
        return NormalizedSection(
            sectionKind: "rest_parameters",
            heading: strField(section["title"]) ?? "Parameters",
            contentText: nameColonDescLines(section["items"], ctx),
            contentJson: stringify(.array(items)), sortOrder: order)
    }

    private static func restParamItem(_ item: JSON, _ source: JSONValue, _ ctx: DocCContext) -> JSONValue {
        object([
            ("name", valueOr(item["name"], .null)),
            ("type", enrichTypeTokens(item["type"], ctx)),
            ("content", resolveContentNodesOr(item["content"], ctx)),
            ("required", valueOr(item["required"], .bool(false))),
            ("source", source),
            ("attributes", valueOr(item["attributes"], .array([]))),
        ])
    }

    static func restResponsesSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        var items: [JSONValue] = []
        var lines: [String] = []
        section["items"].forEachElement { item in
            items.append(
                object([
                    ("status", valueOr(item["status"], .null)),
                    ("reason", valueOr(item["reason"], .null)),
                    ("mimeType", valueOr(item["mimeType"], .null)),
                    ("type", enrichTypeTokens(item["type"], ctx)),
                    ("content", resolveContentNodesOr(item["content"], ctx)),
                ]))
            let status = coerceOrEmpty(item["status"])
            let reason = coerceOrEmpty(item["reason"])
            lines.append(trimJS("\(status) \(reason): \(descriptionText(item["content"], ctx))"))
        }
        let joined = lines.joined(separator: "\n")
        return NormalizedSection(
            sectionKind: "rest_responses",
            heading: strField(section["title"]) ?? "Response Codes",
            contentText: joined.isEmpty ? nil : joined,
            contentJson: stringify(.array(items)), sortOrder: order)
    }

    // MARK: - possibleValues

    static func possibleValuesSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        var values: [JSONValue] = []
        section["values"].forEachElement { value in
            values.append(
                object([
                    ("name", valueOr(value["name"], .null)),
                    ("content", resolveContentNodesOr(value["content"], ctx)),
                ]))
        }
        return NormalizedSection(
            sectionKind: "possible_values",
            heading: strField(section["title"]) ?? "Possible Values",
            contentText: nameColonDescLines(section["values"], ctx),
            contentJson: stringify(.array(values)), sortOrder: order)
    }

    // MARK: - mentions

    static func mentionsSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        var items: [JSONValue] = []
        var titles: [String] = []
        section["mentions"].forEachElement { idNode in
            let id = idNode.string
            items.append(
                object([
                    ("identifier", JSONValue(idNode)),
                    ("key", ctx.resolvedKeyValue(id)),
                    ("title", ctx.refTitleValue(ctx.lookup(id)) ?? resolvedTitleValue(id, idNode)),
                ]))
            titles.append(resolvedTitleText(idNode, ctx))
        }
        let joined = titles.joined(separator: "\n")
        return NormalizedSection(
            sectionKind: "mentioned_in", heading: "Mentioned in",
            contentText: joined.isEmpty ? nil : joined,
            contentJson: stringify(.array(items)), sortOrder: order)
    }

    // MARK: - discussion / fallback (content nodes)

    /// A `content` primary section → a `discussion` section (heading from the first heading node).
    static func discussionSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        let content = section["content"]
        let text = renderNodesText(content, ctx)
        return NormalizedSection(
            sectionKind: "discussion", heading: extractFirstHeading(content, ctx) ?? "Overview",
            contentText: text.isEmpty ? nil : text,
            contentJson: stringify(resolveContentNodesOr(content, ctx)), sortOrder: order)
    }

    /// An unhandled primary section with content → a best-effort `discussion` section.
    static func fallbackSection(_ section: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection {
        let content = section["content"]
        let text = renderNodesText(content, ctx)
        return NormalizedSection(
            sectionKind: "discussion", heading: fallbackHeading(section, content, ctx),
            contentText: text.isEmpty ? nil : text,
            contentJson: stringify(resolveContentNodesOr(content, ctx)), sortOrder: order)
    }

    /// `section.title ?? extractFirstHeading(nodes) ?? section.kind ?? 'Section'`.
    private static func fallbackHeading(_ section: JSON, _ content: JSON, _ ctx: DocCContext) -> String {
        if let title = strField(section["title"]) { return title }
        if let heading = extractFirstHeading(content, ctx) { return heading }
        if let kind = strField(section["kind"]) { return kind }
        return "Section"
    }

    // MARK: - link sections (topics / relationships / seeAlso)

    static func linkSection(
        _ sections: JSON, kind: String, heading: String, _ ctx: DocCContext, order: Int
    ) -> NormalizedSection {
        NormalizedSection(
            sectionKind: kind, heading: heading,
            contentText: renderLinkSectionsText(sections, ctx),
            contentJson: stringify(normalizeLinkSections(sections, ctx)), sortOrder: order)
    }

    // MARK: - shared reference-title projections (mentions)

    /// `ref?.title ?? normalizeIdentifier(id) ?? id` as a JSON value (mentions title).
    private static func resolvedTitleValue(_ id: String?, _ idNode: JSON) -> JSONValue {
        if let id, let norm = Identifier.normalize(id) { return .string(norm) }
        return JSONValue(idNode)
    }

    /// `ref?.title ?? normalizeIdentifier(id) ?? id` coerced to text (mentions contentText, unfiltered).
    private static func resolvedTitleText(_ idNode: JSON, _ ctx: DocCContext) -> String {
        let id = idNode.string
        if let ref = ctx.lookup(id) {
            let title = ref["title"]
            if title.exists, !title.isNull { return title.jsString }
        }
        if let id, let norm = Identifier.normalize(id) { return norm }
        return id ?? idNode.jsString
    }

    /// A present, non-null field as `String?` (`x ?? null` over a string field, keeping `""`).
    static func strField(_ node: JSON) -> String? {
        guard node.exists, !node.isNull else { return nil }
        return node.string
    }
}

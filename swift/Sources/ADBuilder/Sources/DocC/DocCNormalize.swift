// The DocC-JSON normalizer entry (port of src/content/normalize/docc.js `normalizeDocC` +
// the src/content/normalize.js dispatch for the DocC source types). Produces the canonical
// `NormalizedPage` (`{ document, sections, relationships }`) from raw DocC JSON.
//
// `apple-docc`, `hig`, and `swift-docc` share this one DocC format; the source-specific key/URL
// overrides ride in as `keyMapper` / `urlBuilder` (identity + the default developer.apple.com
// URL for the base normalize — the B3 adapters pass their overrides).

public import ADJSONCore
import OrderedCollections

extension DocC {
    /// `normalizeDocC(json, key, sourceType, opts)` — the pure DocC transform.
    ///
    /// - Parameters:
    ///   - root: the parsed DocC JSON root (a non-object root degrades to the empty-document case).
    ///   - key: the canonical corpus key (e.g. `swiftui/view`).
    ///   - sourceType: `apple-docc` | `hig` | `swift-docc` (and the B3 DocC adapters).
    ///   - keyMapper: `opts.keyMapper` — remap every resolved reference key (default identity).
    ///   - urlBuilder: `opts.urlBuilder` — override the document URL from the key (default nil →
    ///     the developer.apple.com documentation/design URL).
    public static func normalizeDocC(
        _ root: JSON, key: String, sourceType: String,
        keyMapper: ((String) -> String)? = nil, urlBuilder: ((String) -> String?)? = nil
    ) -> NormalizedPage {
        let ctx = DocCContext(references: root["references"], keyMapper: keyMapper ?? { $0 })
        let document = buildDocument(
            root, key: key, sourceType: sourceType, ctx, urlBuilder: urlBuilder)
        let sections = buildSections(root, ctx)
        let relationships = extractRelationships(root, key: key, ctx)
        return NormalizedPage(document: document, sections: sections, relationships: relationships)
    }

    /// Parse raw DocC JSON bytes then normalize — the adapter entry (`nil` on a parse failure, which
    /// the crawl driver counts as a per-key failure). The 512-depth cap matches the render layer's
    /// content-node recursion bound (`ADJSON.parse(maxDepth: 512)`).
    public static func normalizeDocC(
        jsonBytes bytes: [UInt8], key: String, sourceType: String,
        keyMapper: ((String) -> String)? = nil, urlBuilder: ((String) -> String?)? = nil
    ) -> NormalizedPage? {
        guard let document = try? ADJSON.parse(bytes, options: JSONParseOptions(maxDepth: 512)) else {
            return nil
        }
        return normalizeDocC(
            document.root, key: key, sourceType: sourceType, keyMapper: keyMapper, urlBuilder: urlBuilder)
    }

    // MARK: - document

    private static func buildDocument(
        _ root: JSON, key: String, sourceType: String, _ ctx: DocCContext,
        urlBuilder: ((String) -> String?)?
    ) -> NormalizedDocument {
        let meta = root["metadata"]
        let role = strField(meta["role"])
        let platforms = resolvePlatforms(meta)
        let abstract = root["abstract"]
        return NormalizedDocument(
            sourceType: sourceType,
            key: key,
            title: strField(meta["title"]),
            kind: resolveKind(root),
            role: role,
            roleHeading: strField(meta["roleHeading"]),
            framework: key.isEmpty ? nil : firstPathSegment(key),
            url: buildURL(key: key, sourceType: sourceType, urlBuilder: urlBuilder),
            language: resolveLanguage(root),
            abstractText: abstract.isTruthy ? renderInlineText(abstract, ctx) : nil,
            declarationText: resolveDeclarationText(root),
            platformsJson: platforms.isEmpty ? nil : stringify(.object(platforms)),
            minIos: platformVersion(platforms, "ios"),
            minMacos: platformVersion(platforms, "macos"),
            minWatchos: platformVersion(platforms, "watchos"),
            minTvos: platformVersion(platforms, "tvos"),
            minVisionos: platformVersion(platforms, "visionos"),
            isDeprecated: meta["deprecated"].bool == true,
            isBeta: meta["beta"].bool == true,
            isReleaseNotes: key.contains("release-notes") || role == "releaseNotes",
            urlDepth: key.isEmpty ? 0 : key.split(separator: "/", omittingEmptySubsequences: false).count - 1,
            headings: collectHeadings(root, ctx),
            sourceMetadata: nil)
    }

    /// `opts.urlBuilder(key) ?? null` when supplied, else the developer.apple.com URL (design/hig
    /// pages use the bare path, documentation pages the `/documentation/` prefix).
    private static func buildURL(key: String, sourceType: String, urlBuilder: ((String) -> String?)?)
        -> String?
    {
        if let urlBuilder { return urlBuilder(key) }
        guard !key.isEmpty else { return nil }
        if sourceType == "hig" || key.hasPrefix("design/") {
            return "https://developer.apple.com/\(key)"
        }
        return "https://developer.apple.com/documentation/\(key)"
    }

    // MARK: - sections (the 11-kind model, in the JS sortOrder)

    private static func buildSections(_ root: JSON, _ ctx: DocCContext) -> [NormalizedSection] {
        var sections: [NormalizedSection] = []
        var order = 0
        let primary = root["primaryContentSections"]

        // Slots 0–3 are RESERVED (order advances even when the section is absent) so declaration is
        // always sortOrder 1, parameters 2, properties 3 — matching the JS `else { order++ }` arms.
        appendReserved(abstractSection(root, ctx, order: order), to: &sections, order: &order)
        appendReserved(declarationSection(primary, ctx, order: order), to: &sections, order: &order)
        appendReserved(maybeParameters(primary, ctx, order: order), to: &sections, order: &order)
        appendReserved(maybeProperties(primary, ctx, order: order), to: &sections, order: &order)

        // From here order advances ONLY on a pushed section.
        primary.forEachElement { section in
            guard section.isObject, section["kind"].utf8Equals("restEndpoint") else { return }
            sections.append(restEndpointSection(section, order: order))
            order += 1
        }
        primary.forEachElement { section in
            guard section.isObject, section["kind"].utf8Equals("restParameters") else { return }
            sections.append(restParametersSection(section, ctx, order: order))
            order += 1
        }
        if let responses = firstSection(primary, kind: "restResponses"),
            isNonEmptyArray(responses["items"])
        {
            sections.append(restResponsesSection(responses, ctx, order: order))
            order += 1
        }
        if let values = firstSection(primary, kind: "possibleValues"),
            isNonEmptyArray(values["values"])
        {
            sections.append(possibleValuesSection(values, ctx, order: order))
            order += 1
        }
        if let mentions = firstSection(primary, kind: "mentions"),
            isNonEmptyArray(mentions["mentions"])
        {
            sections.append(mentionsSection(mentions, ctx, order: order))
            order += 1
        }
        primary.forEachElement { section in
            guard section.isObject, section["kind"].utf8Equals("content") else { return }
            sections.append(discussionSection(section, ctx, order: order))
            order += 1
        }
        primary.forEachElement { section in
            guard section.isObject, !isHandledKind(section["kind"]),
                isNonEmptyArray(section["content"])
            else { return }
            sections.append(fallbackSection(section, ctx, order: order))
            order += 1
        }
        appendLinkSection(root, "topicSections", "topics", "Topics", ctx, &sections, &order)
        appendLinkSection(root, "relationshipsSections", "relationships", "Relationships", ctx, &sections, &order)
        appendLinkSection(root, "seeAlsoSections", "see_also", "See Also", ctx, &sections, &order)
        return sections
    }

    /// Push a reserved-slot section if present, then ALWAYS advance the slot counter.
    private static func appendReserved(
        _ section: NormalizedSection?, to sections: inout [NormalizedSection], order: inout Int
    ) {
        if let section { sections.append(section) }
        order += 1
    }

    private static func abstractSection(_ root: JSON, _ ctx: DocCContext, order: Int) -> NormalizedSection? {
        let abstract = root["abstract"]
        guard isNonEmptyArray(abstract) else { return nil }
        return NormalizedSection(
            sectionKind: "abstract", heading: nil, contentText: renderInlineText(abstract, ctx),
            contentJson: stringify(JSONValue(abstract)), sortOrder: order)
    }

    private static func declarationSection(_ primary: JSON, _ ctx: DocCContext, order: Int)
        -> NormalizedSection?
    {
        guard let section = firstSection(primary, kind: "declarations") else { return nil }
        return NormalizedSection(
            sectionKind: "declaration", heading: "Declaration",
            contentText: declarationTokensText(section),
            contentJson: stringify(enrichDeclarationTokens(section["declarations"], ctx)),
            sortOrder: order)
    }

    private static func maybeParameters(_ primary: JSON, _ ctx: DocCContext, order: Int)
        -> NormalizedSection?
    {
        guard let section = firstSection(primary, kind: "parameters"),
            isNonEmptyArray(section["parameters"])
        else { return nil }
        return parametersSection(section, ctx, order: order)
    }

    private static func maybeProperties(_ primary: JSON, _ ctx: DocCContext, order: Int)
        -> NormalizedSection?
    {
        guard let section = firstSection(primary, kind: "properties"),
            isNonEmptyArray(section["items"])
        else { return nil }
        return propertiesSection(section, ctx, order: order)
    }

    private static func appendLinkSection(
        _ root: JSON, _ field: String, _ kind: String, _ heading: String, _ ctx: DocCContext,
        _ sections: inout [NormalizedSection], _ order: inout Int
    ) {
        let node = root[field]
        guard isNonEmptyArray(node) else { return }
        sections.append(linkSection(node, kind: kind, heading: heading, ctx, order: order))
        order += 1
    }

    /// The primary-section kinds handled by a dedicated arm (so the fallback skips them).
    private static func isHandledKind(_ kind: JSON) -> Bool {
        kind.utf8Equals("declarations") || kind.utf8Equals("parameters") || kind.utf8Equals("content")
            || kind.utf8Equals("properties") || kind.utf8Equals("restEndpoint")
            || kind.utf8Equals("restParameters") || kind.utf8Equals("restResponses")
            || kind.utf8Equals("possibleValues") || kind.utf8Equals("mentions")
    }
}

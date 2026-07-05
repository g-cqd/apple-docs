// The ad-server MCP tool surface. Each tool's input is an ADJSON
// `@Schemable & Decodable` struct — the macro derives the JSON Schema AND gives typed
// decoding; handlers call ADStorage queries / Cascade / WebRoutes builders. Result
// payload bytes flow back through the MCP dispatcher as
// `{content:[{type:text,text}], structuredContent}`.
//
// Schemas use `@Schemable(dialect: .draft7)` + `@SchemaInfo`/`@SchemaNumber` + Swift
// enums so `tools/list` is byte-for-byte equal to the SDK's zod schemas.

import ADJSON
import ADSearchCascade
import ADServeCore
import ADServeDSL
import ADStorage

/// MCP `instructions` — injected once per session by clients.
let mcpInstructions =
    "Local offline index of Apple developer documentation: DocC frameworks, HIG, App Store Review Guidelines, Swift Evolution/book/org, WWDC sessions, sample code, Swift packages, SF Symbols, Apple fonts. Typical flow: search_docs, then read_doc with a hit's path (paginate long pages with maxChars). browse/list_frameworks explore structure; list_taxonomy enumerates filter values. All tools are read-only and fast."

/// The MCP server identity, shared by the stdio + HTTP transports.
func mcpServerInfo(version: String) -> MCPServerInfo {
    MCPServerInfo(name: "apple-docs", version: version, instructions: mcpInstructions)
}

// MARK: - Tool surface

func mcpToolRegistry() -> ToolRegistry {
    ToolRegistry {
        Tool(
            "search_docs",
            "Search Apple developer docs (keyword + semantic). Prefer compact symbol/API terms; put constraints in filter args, not the query. Set read=true to inline the top hit's content."
        )
        .input(SearchDocsInput.self)
        .respond { input, ctx in searchDocs(input, ctx) }

        Tool(
            "list_taxonomy",
            "List distinct taxonomy values with counts (top 20 per field). Use to pick valid search_docs kind filters."
        )
        .input(ListTaxonomyInput.self)
        .respond { input, ctx in listTaxonomy(input, ctx) }

        Tool(
            "list_frameworks",
            "List indexed documentation roots (frameworks, HIG, guidelines, WWDC, tooling, ...) with page counts."
        )
        .input(ListFrameworksInput.self)
        .respond { input, ctx in listFrameworks(input, ctx) }

        Tool("search_sf_symbols", "Search SF Symbols by name, category, alias, or keyword.")
            .input(SearchSfSymbolsInput.self)
            .respond { input, ctx in searchSfSymbols(input, ctx) }

        Tool("list_apple_fonts", "List Apple font families and files (ids feed render_font_text).")
            .input(ListAppleFontsInput.self)
            .respond { _, ctx in .ok(WebRoutes.fonts(ctx.db)) }

        // render_sf_symbol: ADRender.SymbolPdf.render → SymbolPdfToSvg.convert (the
        // byte-exact Swift port of symbol-pdf-to-svg.js). Gated by the live
        // `tools/call render_sf_symbol == oracle` (svg) parity test.
        Tool(
            "render_sf_symbol",
            "Render an SF Symbol to SVG (inlined) or PNG (fetch via returned resource URI)."
        )
        .input(RenderSfSymbolInput.self)
        .respond { input, ctx in renderSfSymbol(input, ctx) }

        Tool("render_font_text", "Render a text preview as SVG using an Apple font.")
            .input(RenderFontTextInput.self)
            .respond { input, ctx in renderFontText(input, ctx) }

        Tool(
            "browse",
            "Walk the documentation topic tree: a root's pages, or one page's children via path. wwdc root returns per-year groups; pass year for that year's sessions."
        )
        .input(BrowseInput.self)
        .respond { input, ctx in browse(input, ctx) }

        Tool(
            "read_doc",
            "Read a documentation page as Markdown, by path or symbol name. Long pages: pass maxChars to paginate, section for one section, or match for excerpts."
        )
        .input(ReadDocInput.self)
        .respond { input, ctx in readDoc(input, ctx) }
    }
}

// MARK: - Handlers

private func searchDocs(_ input: SearchDocsInput, _ ctx: MCPToolContext) -> MCPToolResult {
    // The cascade already emits the MCP search_docs payload (webPaths:false) —
    // search()'s defaults (fuzzy on, noDeep off) match the cascade's always-on
    // behavior. limit default 25.
    guard input.query.utf8.count <= maxSearchQueryBytes else {
        return .failure("query too long (max \(maxSearchQueryBytes) bytes)")
    }
    if let error = validateBound(input.limit, 1 ... 100, field: "limit") { return .failure(error) }
    if let error = Pagination.validateArgs(maxChars: input.maxChars, page: input.page) {
        return .failure(error)
    }
    if let match = input.match, let error = validateMatchBounds(match) { return .failure(error) }

    let params = SearchParams(
        query: input.query, limit: input.limit ?? 25, offset: 0,
        framework: input.framework, source: input.source, kind: input.kind,
        language: input.language?.rawValue, platform: input.platform?.rawValue,
        minIos: input.minVersion?.ios, minMacos: input.minVersion?.macos,
        minWatchos: input.minVersion?.watchos, minTvos: input.minVersion?.tvos,
        minVisionos: input.minVersion?.visionos,
        year: input.year, track: input.track, deprecated: input.deprecated?.rawValue)

    // Fast path — unchanged: raw envelope bytes, no re-parse. `read`/`match`
    // only apply inside the read-mode branch below (JS: `matchOpts` is
    // destructured unconditionally but only ever CONSUMED under `if
    // (args.read && result.results.length > 0)`), and `maxChars`/`page` are
    // the only fields the plain results array needs.
    let needsRichPath = (input.read ?? false) || input.maxChars != nil
    guard needsRichPath else {
        return .ok(Cascade.search(ctx.db, params))
    }

    let outcome = Cascade.search(ctx.db, params, semantic: nil)
    if input.read == true, let hit = outcome.hits.first {
        return readTopHit(hit, match: input.match, maxChars: input.maxChars, page: input.page ?? 1, ctx: ctx)
    }
    return searchResultsPayload(outcome, maxChars: input.maxChars, page: input.page ?? 1)
}

private func listTaxonomy(_ input: ListTaxonomyInput, _ ctx: MCPToolContext) -> MCPToolResult {
    let limit: Int? = (input.all ?? false) ? nil : 20
    // The five MCP fields → SQL columns (docKind reuses the kind column).
    let fields: [(name: String, column: TaxonomyColumn)] = [
        ("kind", .kind), ("role", .role), ("docKind", .kind), ("roleHeading", .roleHeading),
        ("sourceType", .sourceType)
    ]
    func entries(_ column: TaxonomyColumn) -> JSONValue {
        .array(
            ctx.db.taxonomyCounts(column: column, limit: limit)
                .map {
                    .object(["value": .string($0.value), "count": .number(Double($0.count))])
                })
    }
    if let field = input.field?.rawValue, let match = fields.first(where: { $0.name == field }) {
        return .okValue(.object([field: entries(match.column)]))
    }
    var out: OrderedDictionary<String, JSONValue> = [:]
    for field in fields { out[field.name] = entries(field.column) }
    return .okValue(.object(out))
}

private func listFrameworks(_ input: ListFrameworksInput, _ ctx: MCPToolContext) -> MCPToolResult {
    if let error = Pagination.validateArgs(maxChars: input.maxChars, page: input.page) {
        return .failure(error)
    }

    let roots = ctx.db.listFrameworkRoots(kind: nonEmptyArg(input.kind))
    let items = roots.map { root in
        JSONValue.object([
            "slug": .string(root.slug), "name": .string(root.name), "kind": .string(root.kind),
            "pageCount": .number(Double(root.pageCount))
        ])
    }
    let base: OrderedDictionary<String, JSONValue> = ["total": .number(Double(roots.count))]

    guard let maxChars = input.maxChars else {
        var out = base
        out["roots"] = .array(items)
        return .okValue(.object(out))
    }
    do {
        return .okValue(
            try Pagination.paginateArray(items: items, maxChars: maxChars, page: input.page ?? 1) {
                slice, pageIndex, totalPages in
                var out = base
                out["roots"] = .array(Array(slice))
                out["pageInfo"] = Pagination.pageInfoJSON(
                    page: pageIndex, totalPages: totalPages, totalItems: items.count)
                return .object(out)
            })
    } catch {
        return .failure(error.message)
    }
}

private func searchSfSymbols(_ input: SearchSfSymbolsInput, _ ctx: MCPToolContext) -> MCPToolResult {
    guard (input.query ?? "").utf8.count <= maxSearchQueryBytes else {
        return .failure("query too long (max \(maxSearchQueryBytes) bytes)")
    }
    if let error = validateBound(input.limit, 1 ... 500, field: "limit") { return .failure(error) }
    let rows = ctx.db.searchSfSymbols(query: input.query ?? "", scope: input.scope?.rawValue, limit: input.limit ?? 100)
    // Lean MCP shape: {results:[{name,scope}]} (NOT the full row).
    let payload = JSONValue.object([
        "results": .array(rows.map { .object(["name": .string($0.name), "scope": .string($0.scope)]) })
    ])
    return .okValue(payload)
}

// render_font_text / render_sf_symbol handlers live in Tools+Render.swift
// (split out to keep this file within the size gate).

private func browse(_ input: BrowseInput, _ ctx: MCPToolContext) -> MCPToolResult {
    if let error = validateBound(input.limit, 1 ... 200, field: "limit") { return .failure(error) }
    if let error = Pagination.validateArgs(maxChars: input.maxChars, page: input.page) {
        return .failure(error)
    }

    let conn = ctx.db
    guard let root = conn.resolveRoot(input.framework) else {
        return .failure("Unknown framework: \(input.framework)")
    }
    let isWwdc = root.sourceType == "wwdc"
    if input.year != nil && !isWwdc {
        return .failure("year only applies to the wwdc root")
    }

    // Drill into a page → its children (projectBrowse keeps {path, title, section}).
    if let path = nonEmptyArg(input.path) {
        guard let page = conn.browsePage(path) else { return .failure("Page not found: \(path)") }
        let children = conn.documentChildren(page.path)
            .map { child in
                JSONValue.object([
                    "path": .string(child.targetPath),
                    "title": child.title.map(JSONValue.string) ?? .null,
                    "section": child.section.map(JSONValue.string) ?? .null
                ])
            }
        let base: OrderedDictionary<String, JSONValue> = [
            "framework": .string(root.displayName), "path": .string(path),
            "title": page.title.map(JSONValue.string) ?? .null
        ]
        return browsePaginatedResult(base: base, fieldName: "children", items: children, input: input)
    }

    var allPages = conn.pagesByRoot(root.slug)

    if isWwdc, let year = input.year {
        allPages = allPages.filter { $0.path.hasPrefix("wwdc/wwdc\(year)-") }
        if allPages.isEmpty { return .failure("No WWDC sessions indexed for \(year)") }
    } else if isWwdc && input.limit == nil {
        // Bare WWDC → per-year groups (a flat 2,800-session list is useless).
        // NOT array-paginated even when maxChars is set: JS's MCP wrapper always
        // paginates a fixed field name (`args.path ? 'children' : 'pages'`)
        // regardless of the underlying shape, so a bare-WWDC call (this `groups`
        // shape) would have `paginateArrayField` look up a nonexistent `pages`
        // field and silently inject a spurious empty `pages: []` alongside the
        // real `groups` — an artifact of a generic helper applied blindly, not a
        // deliberate feature (groups top out around a couple dozen years, never
        // needing pagination in practice). Judgment call: skip it rather than
        // replicate the quirk.
        var counts: [Int: Int] = [:]
        for page in allPages { if let year = wwdcYear(page.path) { counts[year, default: 0] += 1 } }
        let groups = counts.keys.sorted(by: >)
            .map { year in
                JSONValue.object(["year": .number(Double(year)), "count": .number(Double(counts[year]!))])
            }
        return .okValue(
            .object([
                "framework": .string(root.displayName), "groups": .array(groups),
                "total": .number(Double(allPages.count))
            ]))
    }

    // Flat pages — MCP passes defaultLimit 100; an explicit limit is validated
    // above (rejects out-of-range instead of clamping).
    let limit = input.limit ?? 100
    let pages = Array(allPages.prefix(limit))
    var base: OrderedDictionary<String, JSONValue> = ["framework": .string(root.displayName)]
    if let year = input.year { base["year"] = .number(Double(year)) }
    let items = pages.map { page in
        JSONValue.object([
            "path": .string(page.path),
            "title": page.title.map(JSONValue.string) ?? .null,
            "kind": (page.roleHeading ?? page.role).map(JSONValue.string) ?? .null,
            "abstract": page.abstract.map(JSONValue.string) ?? .null
        ])
    }
    base["total"] = .number(Double(allPages.count))
    return browsePaginatedResult(base: base, fieldName: "pages", items: items, input: input)
}

/// Shared by browse's two array-shaped branches (drill-in children / flat
/// pages): `paginateArrayField(result, fieldName, {maxChars, page,
/// strategy:'items'})` when `maxChars` is set, else the unpaginated array —
/// exactly as before this change.
private func browsePaginatedResult(
    base: OrderedDictionary<String, JSONValue>, fieldName: String, items: [JSONValue], input: BrowseInput
) -> MCPToolResult {
    guard let maxChars = input.maxChars else {
        var out = base
        out[fieldName] = .array(items)
        return .okValue(.object(out))
    }
    do {
        return .okValue(
            try Pagination.paginateArray(items: items, maxChars: maxChars, page: input.page ?? 1) {
                slice, pageIndex, totalPages in
                var out = base
                out[fieldName] = .array(Array(slice))
                out["pageInfo"] = Pagination.pageInfoJSON(
                    page: pageIndex, totalPages: totalPages, totalItems: items.count)
                return .object(out)
            })
    } catch {
        return .failure(error.message)
    }
}

/// `/^wwdc\/wwdc(\d{4})-/` → the 4-digit year.
private func wwdcYear(_ path: String) -> Int? {
    let prefix = "wwdc/wwdc"
    guard path.hasPrefix(prefix) else { return nil }
    let rest = path.dropFirst(prefix.count)
    let digits = rest.prefix(4)
    guard digits.count == 4, digits.allSatisfy(\.isNumber), rest.dropFirst(4).first == "-" else {
        return nil
    }
    return Int(digits)
}

// MARK: - read_doc

/// `lookup()` + `buildMatchedDocumentPayload` + `paginateDocumentPayload` +
/// `projectReadDoc({full})`, fused: resolve the page (`Tools+Lookup.swift`'s
/// `resolveDocument`), take the `section`-extraction early return if
/// requested (bypasses match/pagination entirely, matching `lookup()`'s own
/// early return), else apply `match` (if any) and then `maxChars`/`page`
/// pagination (`DocumentPagination.swift`) over whatever `match` left behind.
private func readDoc(_ input: ReadDocInput, _ ctx: MCPToolContext) -> MCPToolResult {
    if let error = Pagination.validateArgs(maxChars: input.maxChars, page: input.page) {
        return .failure(error)
    }
    if let match = input.match, let error = validateMatchBounds(match) { return .failure(error) }

    guard
        let resolved = resolveDocument(
            path: input.path, symbol: input.symbol, framework: input.framework, conn: ctx.db)
    else {
        // { found: false, path: opts.path ?? opts.symbol } → projectReadDoc drops
        // everything but found (no note here).
        return .okValue(.object(["found": .bool(false)]))
    }

    // Section extraction bypasses match/pagination entirely — JS's `lookup()`
    // has its own early return for this, before the MCP handler's
    // match/paginate steps ever run.
    if let sectionQuery = input.section, !resolved.sections.isEmpty {
        return sectionResult(resolved, query: sectionQuery)
    }

    let includeSections = input.maxChars != nil || input.match != nil || input.section != nil
    var envelope = Pagination.DocumentEnvelope(
        metadata: .object(resolved.metadata), content: resolved.content,
        sections: includeSections ? resolved.sections : [], note: resolved.note, matches: nil,
        bestMatch: nil, renderDocument: docMarkdownDocument(resolved.record))

    if let match = input.match { applyMatch(match, sections: resolved.sections, to: &envelope) }

    let full = input.section != nil || input.match != nil || input.maxChars != nil
    do {
        return .okValue(
            try Pagination.buildDocumentResult(envelope, maxChars: input.maxChars, page: input.page ?? 1, full: full))
    } catch {
        return .failure(error.message)
    }
}

// MARK: - helpers

private func nonEmptyArg(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

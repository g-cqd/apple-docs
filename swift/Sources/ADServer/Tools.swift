// The ad-server MCP tool surface. Each tool's input is an ADJSON
// `@Schemable & Decodable` struct — the macro derives the JSON Schema AND gives typed
// decoding; handlers call ADStorage queries / Cascade / WebRoutes builders. Result
// payload bytes flow back through the MCP dispatcher as
// `{content:[{type:text,text}], structuredContent}`.
//
// Schemas use `@Schemable(dialect: .draft7)` + `@SchemaInfo`/`@SchemaNumber` + Swift
// enums so `tools/list` is byte-for-byte equal to the SDK's zod schemas.

import ADContent
import ADFCore
import ADJSON
import ADRender
import ADSearchCascade
import ADServeCore
import ADServeDSL
import ADStorage
import Foundation

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
    let params = SearchParams(
        query: input.query, limit: clampSearchLimit(input.limit ?? 25, upperBound: 100), offset: 0,
        framework: input.framework, source: input.source, kind: input.kind,
        language: input.language?.rawValue, platform: input.platform?.rawValue,
        minIos: input.minVersion?.ios, minMacos: input.minVersion?.macos,
        minWatchos: input.minVersion?.watchos, minTvos: input.minVersion?.tvos,
        minVisionos: input.minVersion?.visionos,
        year: input.year, track: input.track, deprecated: input.deprecated?.rawValue)
    return .ok(Cascade.search(ctx.db, params))
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
    let roots = ctx.db.listFrameworkRoots(kind: nonEmptyArg(input.kind))
    let payload = JSONValue.object([
        "total": .number(Double(roots.count)),
        "roots": .array(
            roots.map {
                .object([
                    "slug": .string($0.slug), "name": .string($0.name), "kind": .string($0.kind),
                    "pageCount": .number(Double($0.pageCount))
                ])
            })
    ])
    return .okValue(payload)
}

private func searchSfSymbols(_ input: SearchSfSymbolsInput, _ ctx: MCPToolContext) -> MCPToolResult {
    guard (input.query ?? "").utf8.count <= maxSearchQueryBytes else {
        return .failure("query too long (max \(maxSearchQueryBytes) bytes)")
    }
    let rows = ctx.db.searchSfSymbols(
        query: input.query ?? "", scope: input.scope?.rawValue, limit: clampSymbolLimitInt(input.limit))
    // Lean MCP shape: {results:[{name,scope}]} (NOT the full row).
    let payload = JSONValue.object([
        "results": .array(rows.map { .object(["name": .string($0.name), "scope": .string($0.scope)]) })
    ])
    return .okValue(payload)
}

// MARK: - render_font_text
//
// Byte-faithful port of apple-assets.js `renderFontText` + `projectRenderFontText`
// for the surface the in-process (`--db`-only) server can actually reproduce.
//
// The JS render: getAppleFontFile(fontId) → text=String(text ?? "Typography"),
// pointSize=clamp(size ?? 96, 8, 512) → assertFontPathContained(file_path,
// dataDir) (else placeholder SVG) → isLikelySfnt probe → engine chain (darwin:
// CoreText, then hb-native, then hb-view; non-darwin: hb-native, then hb-view) →
// placeholder on failure. Result projects to `{ text, mimeType, content }` (font
// + format dropped).
//
// Engine chain — matches JS's `_resolveFontTextEngines` order exactly, first
// non-nil result wins: CoreText (`FontText.renderSVG`, darwin-only) → hb-native
// (`ADRender.HarfBuzzShaper.renderSVG`, the dlopen'd in-process HarfBuzz shim
// RenderExports.swift already exposes over FFI for the JS native bridge — wired
// into THIS chain too now) → hb-view (`ADRender.HbViewRenderer.renderSVG`, spawns
// the system `hb-view` CLI when installed).
//
// One honest remaining deviation from the JS oracle, forced by the server having
// no CLI-flag dataDir (MCPCommand opens only --db; `MCPToolContext` carries just
// (connection, logger), so an explicit `--home` override on THIS process isn't
// visible here): path-safety. The JS allowlist roots are /Library/Fonts,
// /System/Library/Fonts, ~/Library/Fonts AND <dataDir>/resources/fonts/extracted.
// The first three are dataDir-independent and checked identically; the 4th is now
// ALSO checked, with dataDir resolved the same way `CorpusOptions.path` resolves
// the corpus home (`$APPLE_DOCS_HOME`, else `~/.apple-docs`) — covering the
// default and env-var configurations every stdio MCP client uses in practice. The
// one narrower gap: a bare `--home /custom/path` CLI flag with no matching
// `$APPLE_DOCS_HOME` still resolves to the default here, so a font that lives
// ONLY under that custom home's `.../extracted` would (incorrectly) hit the
// placeholder. Reported, not hidden; System/home-root fonts, the default/env-var
// dataDir case, and off-root paths all match the JS oracle exactly.

private func renderFontText(_ input: RenderFontTextInput, _ ctx: MCPToolContext) -> MCPToolResult {
    // getAppleFontFile(fontId) — a missing row is a not-found (JS NotFoundError →
    // the dispatcher's isError result, which the parity oracle's try/catch maps to
    // a self-skip).
    guard let font = ctx.db.getAppleFontFileRecord(id: input.fontId) else {
        return .failure("Font file not found: \(input.fontId)")
    }
    let text = input.text ?? "Typography"
    // dataDir: nil — MCPToolContext carries only a connection + logger (MCPCommand opens just
    // --db), so only the 3 dataDir-independent system roots are checked; see
    // `renderFontTextCore`'s own doc for the HTTP route's wider check.
    let rendered = renderFontTextCore(font: font, text: text, size: input.size, dataDir: nil)
    // projectRenderFontText: { text, mimeType, content } in that key order.
    return .okValue(
        .object([
            "text": .string(rendered.text),
            "mimeType": .string(rendered.mimeType),
            "content": .string(rendered.content)
        ]))
}

/// The result of `renderFontTextCore` — `{ text, mimeType, content }`, matching the JS
/// `projectRenderFontText` projection the MCP tool returns.
struct FontTextRender: Sendable {
    let text: String
    let mimeType: String
    let content: String
}

/// The shared `render_font_text` core (byte-faithful port of apple-fonts/render.js's CoreText
/// path): clamps `pointSize`, then renders via CoreText when the font's path passes containment
/// + looks like a real SFNT font, else falls back to the placeholder SVG. Shared by the MCP
/// `render_font_text` tool above (`dataDir: nil`) and the HTTP `/api/fonts/text.svg` route
/// (`dataDir` from `--home`/`$APPLE_DOCS_HOME`) — see `FontPathContainment`'s header comment for
/// why the two callers check a different root set.
func renderFontTextCore(font: AppleFontFileRecord, text: String, size: Int?, dataDir: String?) -> FontTextRender {
    let pointSize = clampInteger(size ?? 96, min: 8, max: 512)
    let family = font.familyDisplayName ?? ""

    let content =
        renderFontTextEngineChain(font: font, text: text, pointSize: pointSize, dataDir: dataDir)
        ?? fontTextSvgFallback(fontFamily: family, text: text, pointSize: pointSize)
    return FontTextRender(text: text, mimeType: "image/svg+xml; charset=utf-8", content: content)
}

/// The CoreText → hb-native → hb-view engine chain over `font`'s file, or nil
/// when the path fails containment/SFNT validation or every engine fails —
/// the caller falls back to the placeholder SVG exactly as JS does. `dataDir`
/// threads through to `FontPathContainment.isContained` (nil from the MCP tool,
/// the resolved `--home`/`$APPLE_DOCS_HOME` from the HTTP route).
private func renderFontTextEngineChain(
    font: AppleFontFileRecord, text: String, pointSize: Int, dataDir: String?
) -> String? {
    guard let path = font.filePath, FontPathContainment.isContained(path, dataDir: dataDir),
        isLikelySfnt(path)
    else { return nil }
    #if canImport(CoreText)
        if let svg = FontText.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize)) {
            return svg
        }
    #endif
    if let bytes = HarfBuzzShaper.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize)) {
        return String(decoding: bytes, as: UTF8.self)
    }
    return HbViewRenderer.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize))
}

/// renderSfSymbol (apple-symbols/render.js) live path: resolve the symbol, render
/// its PDF via ADRender, and convert to SVG (SymbolPdfToSvg). The in-process server
/// has no dataDir/cache/snapshot layer, so this is the live render only; PNG bytes
/// are fetched via the returned resource URI (not inlined). projectRenderSfSymbol
/// drops file_path + (for png) svg → { name, scope, format, resourceUri, svg? }.
private func renderSfSymbol(_ input: RenderSfSymbolInput, _ ctx: MCPToolContext) -> MCPToolResult {
    // SF Symbol PDF→SVG rasterization needs AppKit/CoreGraphics — Darwin only.
    #if canImport(AppKit)
        let scope = input.scope ?? .public
        let format = input.format ?? .png
        let pointSize = clampInteger(input.size ?? 64, min: 8, max: 1024)
        // weight/scale arrive pre-validated from the schema enum; public-only.
        let weight = scope == .public ? (input.weight?.rawValue ?? "regular") : "regular"
        let scale = scope == .public ? (input.scale?.rawValue ?? "medium") : "medium"
        let rawColor = input.color ?? "#000000"
        let color =
            (format == .svg && rawColor.lowercased() == "currentcolor")
            ? "currentColor" : normalizeSymbolColor(rawColor)
        let background = normalizeSymbolBackground(input.background)

        guard let symbol = ctx.db.getSfSymbol(scope: scope.rawValue, name: input.name) else {
            return .failure("SF Symbol not found: \(scope.rawValue)/\(input.name)")
        }
        if let unsupported = symbol.renderUnsupported, unsupported != 0 {
            return .failure(
                "SF Symbol \(scope.rawValue)/\(input.name) is cataloged but not renderable from this snapshot — its glyph ships with a newer macOS than the build host. Beta snapshots built on that macOS carry it (apple-docs setup --beta)."
            )
        }

        let resourceUri =
            "apple-docs://sf-symbol/\(scope.rawValue)/\(encodeURIComponentJS(input.name)).\(format.rawValue)"
        var out: OrderedDictionary<String, JSONValue> = [
            "name": .string(input.name), "scope": .string(scope.rawValue),
            "format": .string(format.rawValue), "resourceUri": .string(resourceUri)
        ]
        if format == .svg {
            guard let pdf = SymbolPdf.render(name: input.name, scope: scope.rawValue, weight: weight, scale: scale)
            else {
                return .failure("SF Symbol render failed: \(scope.rawValue)/\(input.name)")
            }
            let svg: String
            do {
                svg = try SymbolPdfToSvg.convert(
                    pdf, options: .init(name: input.name, pointSize: pointSize, color: color, background: background))
            } catch {
                return .failure("SF Symbol SVG conversion failed for \(scope.rawValue)/\(input.name): \(error)")
            }
            out["svg"] = .string(svg)
        }
        return .okValue(.object(out))
    #else
        return .failure("SF Symbol rendering needs AppKit/CoreGraphics — unavailable on this platform.")
    #endif
}

/// normalizeColor (apple-assets-helpers.js): a trimmed `#RRGGBB(AA)` hex
/// (case-insensitive) passes through; anything else → `#000000`. Shared with the HTTP
/// `/api/symbols/<scope>/<name>.(svg|png)` route (`renderSfSymbolBytes`, RenderShared.swift).
func normalizeSymbolColor(_ value: String?) -> String {
    let raw = (value ?? "#000000").trimmingCharacters(in: .whitespacesAndNewlines)
    return isHexColor(raw) ? raw : "#000000"
}

/// normalizeBackground: nil/empty/`transparent`/`none` → nil; `#RRGGBB(AA)` → raw; else nil.
/// Shared with the HTTP symbol-render route (see `normalizeSymbolColor`).
func normalizeSymbolBackground(_ value: String?) -> String? {
    guard let value else { return nil }
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty || raw == "transparent" || raw == "none" { return nil }
    return isHexColor(raw) ? raw : nil
}

/// JS `/^#[0-9a-f]{6}([0-9a-f]{2})?$/i`.
private func isHexColor(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 7 || u.count == 9, u[0] == 0x23 else { return false }
    for b in u[1...] {
        let hex = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
        if !hex { return false }
    }
    return true
}

/// `encodeURIComponent`: percent-encode every byte except the JS unreserved set
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
private func encodeURIComponentJS(_ s: String) -> String {
    let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    var out = ""
    for b in s.utf8 {
        if unreserved.contains(b) {
            out.unicodeScalars.append(Unicode.Scalar(b))
        } else {
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

/// `clampInteger(value, min, max)` — JS `Math.min(Math.max(parseInt(value), min),
/// max)`, NaN → min. The input is already an `Int?`, so the parse never fails. Shared with the
/// HTTP font-text and symbol-render routes (RenderShared.swift).
func clampInteger(_ value: Int, min lo: Int, max hi: Int) -> Int {
    min(max(value, lo), hi)
}

/// `isLikelySfnt(path)` — reads the 4-byte magic: OTTO/ttcf/wOFF/wOF2, or the
/// 0x00010000 TrueType version. Any read failure → false.
private func isLikelySfnt(_ path: String) -> Bool {
    guard let handle = FileHandle(forReadingAtPath: path) else { return false }
    defer { try? handle.close() }
    guard let head = try? handle.read(upToCount: 4), head.count == 4 else { return false }
    let bytes = [UInt8](head)
    if let tag = String(bytes: bytes, encoding: .ascii),
        tag == "OTTO" || tag == "ttcf" || tag == "wOFF" || tag == "wOF2"
    {
        return true
    }
    return bytes == [0x00, 0x01, 0x00, 0x00]
}

/// `renderFontTextSvgFallback` from apple-fonts/render.js, character-for-
/// character: a `<text>` placeholder sized from the text length + point size.
private func fontTextSvgFallback(fontFamily: String, text: String, pointSize: Int) -> String {
    let height = Int((Double(pointSize) * 1.6).rounded(.up))
    // JS `text.length` is the UTF-16 code-unit count, not grapheme count.
    let width = max(240, Int((Double(text.utf16.count) * Double(pointSize) * 0.62).rounded(.up)))
    let baseline = Int((Double(pointSize) * 1.1).rounded(.up))
    let label = xmlEscaped(text)
    return """
        <?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" viewBox="0 0 \(width) \(height)" role="img" aria-label="\(label)">
          <text x="0" y="\(baseline)" font-family="\(xmlEscaped(fontFamily))" font-size="\(pointSize)" fill="black">\(label)</text>
        </svg>
        """
}

/// XML/SVG attribute & text escape — the five XML 1.0 predefined entities (`& < > " '`), now via the
/// shared `ADFCore.XMLEscape` (byte-identical to the prior `replacingOccurrences` chain).
private func xmlEscaped(_ value: String) -> String { XMLEscape.escaped(value) }

private func browse(_ input: BrowseInput, _ ctx: MCPToolContext) -> MCPToolResult {
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
        return .okValue(
            .object([
                "framework": .string(root.displayName), "path": .string(path),
                "title": page.title.map(JSONValue.string) ?? .null, "children": .array(children)
            ]))
    }

    var allPages = conn.pagesByRoot(root.slug)

    if isWwdc, let year = input.year {
        allPages = allPages.filter { $0.path.hasPrefix("wwdc/wwdc\(year)-") }
        if allPages.isEmpty { return .failure("No WWDC sessions indexed for \(year)") }
    } else if isWwdc && input.limit == nil {
        // Bare WWDC → per-year groups (a flat 2,800-session list is useless).
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

    // Flat pages — MCP passes defaultLimit 100; an explicit limit is clamped ≥ 1.
    let limit = input.limit.map { max($0, 1) } ?? 100
    let pages = Array(allPages.prefix(limit))
    var out: OrderedDictionary<String, JSONValue> = ["framework": .string(root.displayName)]
    if let year = input.year { out["year"] = .number(Double(year)) }
    out["pages"] = .array(
        pages.map { page in
            JSONValue.object([
                "path": .string(page.path),
                "title": page.title.map(JSONValue.string) ?? .null,
                "kind": (page.roleHeading ?? page.role).map(JSONValue.string) ?? .null,
                "abstract": page.abstract.map(JSONValue.string) ?? .null
            ])
        })
    out["total"] = .number(Double(allPages.count))
    return .okValue(.object(out))
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

/// lookup() + projectReadDoc({ full }). Resolves the page (path → document,
/// then normalized-identifier retry; or symbol → searchByTitle), assembles the
/// metadata + relationship counts + content + note exactly as the JS command,
/// then projects to the public read_doc shape. Integer-valued fields use `.int`
/// so the MCP `content[0].text` JSON matches `JSON.stringify` byte-for-byte.
///
/// Pagination / match-excerpt / single-section args (`maxChars` / `match` /
/// `section`) widen `includeSections`; the JS tool then runs the
/// buildMatchedDocumentPayload / paginateDocumentPayload transforms, which live
/// in the MCP pagination layer (not `lookup`). Those transforms are not yet
/// ported, so this handler covers the un-paginated lookup surface the parity
/// gate exercises.
private func readDoc(_ input: ReadDocInput, _ ctx: MCPToolContext) -> MCPToolResult {
    let conn = ctx.db
    let includeSections = input.maxChars != nil || input.match != nil || input.section != nil

    // Resolve: opts.path (with a normalize-identifier retry), else opts.symbol.
    var record: DocumentRecord?
    let requested: String?
    if let path = input.path {
        requested = path
        record = conn.readDocument(path)
        if record == nil, let normalized = normalizeIdentifier(path), normalized != path {
            record = conn.readDocument(normalized)
        }
    } else if let symbol = input.symbol {
        requested = symbol
        record = conn.searchByTitle(symbol, framework: input.framework)
    } else {
        requested = nil
    }

    guard let page = record else {
        // { found: false, path: opts.path ?? opts.symbol } → projectReadDoc drops
        // everything but found (no note here).
        _ = requested
        return .okValue(.object(["found": .bool(false)]))
    }

    let pagePath = page.path

    // Content: JS `lookup` renders INDEPENDENTLY of includeSections — it always
    // loads the DB sections and, when present, renders Markdown on-demand
    // (fallback=true). The in-process server has no persisted .md and no
    // raw-json/hydrate path, so the section render is the one reachable source;
    // an empty section list leaves content null (→ the tier note). Sections are
    // always loaded for rendering, but only RETURNED when includeSections.
    let sections = conn.documentSections(pagePath)
    let rendered = sections.isEmpty ? nil : renderDocMarkdown(page, sections)
    let content: JSONValue = rendered.map(JSONValue.string) ?? .null

    // relationshipCounts → camelCase, GROUP BY row order; empty object dropped by
    // the projection.
    let relationships = relationshipCountsObject(conn.relationshipCountsByType(pagePath))

    // projectMetadata's pick keep-order: title, framework, rootSlug, roleHeading,
    // kind, abstract, declaration, path, platforms, relationships — then the
    // isDeprecated / isBeta flags (true-only).
    var metadata: OrderedDictionary<String, JSONValue> = [
        "title": page.title.map(JSONValue.string) ?? .null,
        "framework": page.frameworkDisplay.map(JSONValue.string) ?? .null,
        "rootSlug": page.rootSlug.map(JSONValue.string) ?? .null,
        "roleHeading": page.roleHeading.map(JSONValue.string) ?? .null,
        "kind": page.kind.map(JSONValue.string) ?? .null,
        "abstract": page.abstract.map(JSONValue.string) ?? .null,
        "declaration": page.declaration.map(JSONValue.string) ?? .null,
        "path": .string(pagePath),
        "platforms": platformsValue(page.platformsJSON)
    ]
    if let relationships { metadata["relationships"] = relationships }
    if page.isDeprecated { metadata["isDeprecated"] = .bool(true) }
    if page.isBeta { metadata["isBeta"] = .bool(true) }

    // Section extraction (full=true): return the one matching section's raw text.
    if let sectionQuery = input.section, !sections.isEmpty {
        if let match = findSection(sections, query: sectionQuery) {
            return .okValue(
                .object([
                    "found": .bool(true), "metadata": .object(metadata),
                    "content": .string(match.contentText ?? "Section content not available."),
                    "sections": .array([projectSectionFull(match)])
                ]))
        }
        let available =
            sections
            .compactMap { $0.heading ?? $0.sectionKind }
            .joined(separator: ", ")
        return .okValue(
            .object([
                "found": .bool(true), "metadata": .object(metadata), "content": .null,
                "sections": .array(sections.map(projectSectionFull)),
                "note": .string("Section not found: \(sectionQuery). Available sections: \(available)")
            ]))
    }

    // Note: when content rendered, JS emits the on-demand-fallback note (the
    // in-process render always sets fallback=true); otherwise the tier note —
    // lite-tier snapshots get the tier-limitation hint, every other tier the
    // sync hint.
    let note: JSONValue
    if rendered != nil {
        note = .string("Rendered on-demand from normalized content.")
    } else if conn.snapshotTier() == "lite" {
        note = .string(
            "Content body unavailable on a legacy lite-tier snapshot. Metadata and declaration shown.")
    } else {
        note = .string("No content available. Run apple-docs sync first.")
    }

    // projectReadDoc(payload, { full }) key order: found, metadata, content,
    // sections, note. `full` toggles the section projection shape. lookup returns
    // `sections: includeSections ? sections : []`, so the envelope's sections are
    // empty unless an explicit pagination/match/section arg widened the request —
    // content rendering does NOT add them.
    let full = input.section != nil || input.match != nil || input.maxChars != nil
    let returnedSections = includeSections ? sections : []
    let projectedSections = returnedSections.map(full ? projectSectionFull : sectionSkeleton)
    return .okValue(
        .object([
            "found": .bool(true), "metadata": .object(metadata), "content": content,
            "sections": .array(projectedSections), "note": note
        ]))
}

/// `renderMarkdown({ ...page, key: pagePath }, sections)` (render-markdown.js)
/// over the in-process document + section rows. Maps the `DocumentRecord`
/// columns onto coerceDocument's field shape (key←path, framework←raw slug,
/// frameworkDisplay←COALESCE display, role/roleHeading/platformsJson) and the
/// `DocumentSectionRow`s onto coerceSection (contentText coerced to "" when
/// null, sortOrder default 0). The default render flags (includeFrontMatter,
/// includeTitle = true) match lookup's bare `renderMarkdown(document, sections)`
/// call. Shared by read_doc and the doc resource so their bytes never diverge.
func renderDocMarkdown(_ page: DocumentRecord, _ sections: [DocumentSectionRow]) -> String {
    let document = DocMarkdownDocument(
        key: page.path, title: page.title, framework: page.framework,
        frameworkDisplay: page.frameworkDisplay, role: page.role, roleHeading: page.roleHeading,
        platformsJSON: page.platformsJSON)
    let mapped = sections.map { section in
        DocMarkdownSection(
            kind: section.sectionKind, heading: section.heading,
            contentText: section.contentText ?? "", contentJSON: section.contentJSON,
            sortOrder: section.sortOrder)
    }
    return DocMarkdown.render(document: document, sections: mapped)
}

/// getRelationshipCountsByType → projectMetadata's `relationships` object:
/// relation_type mapped to camelCase (unmapped types dropped), counts as `.int`
/// so they serialize as `2` not `2.0`. nil when the object would be empty (the
/// projection drops the key).
private func relationshipCountsObject(_ counts: [RelationshipCount]) -> JSONValue? {
    var out: OrderedDictionary<String, JSONValue> = [:]
    for entry in counts {
        guard let camel = relationTypeToCamel(entry.relationType) else { continue }
        out[camel] = .int(Int64(entry.count))
    }
    return out.isEmpty ? nil : .object(out)
}

/// RELATION_TYPE_TO_CAMEL: DB relation_type slug → camelCase public name.
/// Anything not listed is dropped (a future relation_type never leaks).
private func relationTypeToCamel(_ relationType: String) -> String? {
    switch relationType {
        case "inherits_from": return "inheritsFrom"
        case "inherited_by": return "inheritedBy"
        case "conforms_to": return "conformsTo"
        case "see-also", "see_also", "seeAlso": return "seeAlso"
        case "child": return "children"
        default: return nil
    }
}

/// `page.platforms ? JSON.parse(page.platforms) : []` — the parsed JSON value
/// (array OR object) when the column is a non-empty string, else `[]`.
private func platformsValue(_ json: String?) -> JSONValue {
    guard let json, !json.isEmpty, let value = try? JSONValue(parsing: json) else { return .array([]) }
    return value
}

/// lookup's section matcher: heading exact / heading suffix / sectionKind exact,
/// then a contentText substring fallback.
private func findSection(_ sections: [DocumentSectionRow], query: String) -> DocumentSectionRow? {
    if let match = sections.first(where: {
        $0.heading == query || ($0.heading?.hasSuffix(query) ?? false) || $0.sectionKind == query
    }) {
        return match
    }
    return sections.first { $0.contentText?.contains(query) ?? false }
}

/// projectSectionFull(section): { heading?, contentText? } — keys present only
/// when defined (null kept).
private func projectSectionFull(_ section: DocumentSectionRow) -> JSONValue {
    var out: OrderedDictionary<String, JSONValue> = [:]
    out["heading"] = section.heading.map(JSONValue.string) ?? .null
    out["contentText"] = section.contentText.map(JSONValue.string) ?? .null
    return .object(out)
}

/// sectionSkeleton(section): { heading, chars } — chars is the contentText
/// length (UTF-16 code-unit count, matching JS String.length), as `.int`.
private func sectionSkeleton(_ section: DocumentSectionRow) -> JSONValue {
    let chars = section.contentText.map { $0.utf16.count } ?? 0
    return .object([
        "heading": section.heading.map(JSONValue.string) ?? .null, "chars": .int(Int64(chars))
    ])
}

// MARK: - helpers

private func nonEmptyArg(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

/// `Math.min(Math.max(limit ?? 100 || 100, 1), 500)` (default 100).
private func clampSymbolLimitInt(_ value: Int?) -> Int {
    let base = (value ?? 100) == 0 ? 100 : (value ?? 100)
    return min(max(base, 1), 500)
}

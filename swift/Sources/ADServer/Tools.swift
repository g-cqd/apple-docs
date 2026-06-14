// The ad-server MCP tool surface (RFC 0005 Phase C). Each tool's input is an ADJSON
// `@Schemable & Decodable` struct — the macro derives the JSON Schema (the zod
// replacement, D-0005-10) AND gives typed decoding; handlers call the existing
// ADStorage queries / Cascade / WebRoutes builders and project to the exact
// `project*()` shapes (src/output/projection.js). Result payload bytes flow back
// through the MCP dispatcher as `{content:[{type:text,text}], structuredContent}`.
//
// Schemas use `@Schemable(dialect: .draft7)` + `@SchemaInfo`/`@SchemaNumber` + Swift
// enums so `tools/list` is byte-for-byte (intrinsic) equal to the SDK's zod schemas.
// Shipped: search_docs (base), list_taxonomy, list_frameworks, search_sf_symbols,
// list_apple_fonts. browse + read_doc/render (Phase D) follow.

import ADJSON
import ADSearchCascade
import ADServeCore
import ADServeDSL
import ADStorage

/// MCP `instructions` (src/mcp/server.js) — injected once per session by clients.
let mcpInstructions =
  "Local offline index of Apple developer documentation: DocC frameworks, HIG, App Store Review Guidelines, Swift Evolution/book/org, WWDC sessions, sample code, Swift packages, SF Symbols, Apple fonts. Typical flow: search_docs, then read_doc with a hit's path (paginate long pages with maxChars). browse/list_frameworks explore structure; list_taxonomy enumerates filter values. All tools are read-only and fast."

/// The MCP server identity, shared by the stdio + HTTP transports.
func mcpServerInfo(version: String) -> MCPServerInfo {
  MCPServerInfo(name: "apple-docs", version: version, instructions: mcpInstructions)
}

// MARK: - Enum fields (→ string `enum`, declaration order)

enum SymbolScope: String, Codable, CaseIterable { case `public`, `private` }
enum TaxonomyField: String, Codable, CaseIterable { case kind, role, docKind, roleHeading, sourceType }
enum SearchLanguage: String, Codable, CaseIterable { case swift, objc }
enum SearchPlatform: String, Codable, CaseIterable { case ios, macos, watchos, tvos, visionos }
enum DeprecatedFilter: String, Codable, CaseIterable { case include, exclude, only }

// MARK: - Input schemas (ADJSON @Schemable, draft-07 to match the MCP SDK)

@Schemable(dialect: .draft7)
struct SearchDocsInput: Decodable {
  // read/maxChars/page/match (inline + pagination + excerpts) ride Phase D — omitted.
  @SchemaInfo(description: #"Search terms, e.g. "NavigationStack"."#) var query: String
  /// Framework slug, e.g. swiftui, app-store-review.
  var framework: String?
  /// Source slug(s), comma-separated: apple-docc, hig, wwdc, sample-code, swift-evolution, ...
  var source: String?
  /// Page kind (values via list_taxonomy).
  var kind: String?
  var language: SearchLanguage?
  var platform: SearchPlatform?
  @SchemaInfo(description: #"Min version per platform, e.g. {"ios":"17.0"}."#) var minVersion: MinVersion?
  /// Max results (default 25).
  @SchemaNumber(1...100) var limit: Int?
  /// WWDC session year.
  @SchemaNumber(type: .number) var year: Int?
  /// WWDC track.
  var track: String?
  /// Default include; use exclude when writing code.
  var deprecated: DeprecatedFilter?
}

@Schemable
struct MinVersion: Decodable {
  var ios: String?
  var macos: String?
  var watchos: String?
  var tvos: String?
  var visionos: String?
}

@Schemable(dialect: .draft7)
struct ListTaxonomyInput: Decodable {
  /// Single field instead of all five.
  var field: TaxonomyField?
  /// Full distribution, not top 20.
  var all: Bool?
}

@Schemable(dialect: .draft7)
struct ListFrameworksInput: Decodable {
  /// Filter: framework, technology, tooling, collection, release-notes, tutorial, guidelines, design.
  var kind: String?
  /// Page size in chars (min 512).
  @SchemaNumber(512...) var maxChars: Int?
  /// 1-based page; needs maxChars.
  @SchemaNumber(1...) var page: Int?
}

@Schemable(dialect: .draft7)
struct SearchSfSymbolsInput: Decodable {
  /// Name or keyword; empty lists all.
  var query: String?
  var scope: SymbolScope?
  /// Max results (default 100).
  @SchemaNumber(1...500) var limit: Int?
}

@Schemable(dialect: .draft7)
struct ListAppleFontsInput: Decodable {}

@Schemable(dialect: .draft7)
struct BrowseInput: Decodable {
  // maxChars/page (pagination) ride Phase D — omitted.
  /// Root slug, e.g. swiftui, design, wwdc.
  var framework: String
  /// Drill into a page, e.g. swiftui/view.
  var path: String?
  /// WWDC sessions of one year.
  var year: Int?
  /// Max pages (default 100, cap 200).
  @SchemaNumber(1...200) var limit: Int?
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
      .respond { _, ctx in .ok(WebRoutes.fonts(ctx.connection)) }

    Tool(
      "browse",
      "Walk the documentation topic tree: a root's pages, or one page's children via path. wwdc root returns per-year groups; pass year for that year's sessions."
    )
    .input(BrowseInput.self)
    .respond { input, ctx in browse(input, ctx) }
  }
}

// MARK: - Handlers (project to the exact projection.js shapes)

private func searchDocs(_ input: SearchDocsInput, _ ctx: MCPToolContext) -> MCPToolResult {
  // The cascade already emits projectSearchResult(webPaths:false) — the MCP variant —
  // and search()'s defaults (fuzzy on, noDeep off) match the cascade's always-on
  // behavior, so the bytes ARE the search_docs payload. limit default 25 (MCP).
  let params = SearchParams(
    query: input.query, limit: input.limit ?? 25, offset: 0,
    framework: input.framework, source: input.source, kind: input.kind,
    language: input.language?.rawValue, platform: input.platform?.rawValue,
    minIos: input.minVersion?.ios, minMacos: input.minVersion?.macos,
    minWatchos: input.minVersion?.watchos, minTvos: input.minVersion?.tvos,
    minVisionos: input.minVersion?.visionos,
    year: input.year, track: input.track, deprecated: input.deprecated?.rawValue)
  return .ok(Cascade.search(ctx.connection, params))
}

private func listTaxonomy(_ input: ListTaxonomyInput, _ ctx: MCPToolContext) -> MCPToolResult {
  let limit: Int? = (input.all ?? false) ? nil : 20
  // The five MCP fields → SQL columns (docKind reuses the kind column).
  let fields: [(name: String, column: TaxonomyColumn)] = [
    ("kind", .kind), ("role", .role), ("docKind", .kind), ("roleHeading", .roleHeading),
    ("sourceType", .sourceType),
  ]
  func entries(_ column: TaxonomyColumn) -> JSONValue {
    .array(
      ctx.connection.taxonomyCounts(column: column, limit: limit).map {
        .object(["value": .string($0.value), "count": .number(Double($0.count))])
      })
  }
  if let field = input.field?.rawValue, let match = fields.first(where: { $0.name == field }) {
    return encodePayload(.object([field: entries(match.column)]))
  }
  var out: [String: JSONValue] = [:]
  for field in fields { out[field.name] = entries(field.column) }
  return encodePayload(.object(out))
}

private func listFrameworks(_ input: ListFrameworksInput, _ ctx: MCPToolContext) -> MCPToolResult {
  let roots = ctx.connection.listFrameworkRoots(kind: nonEmptyArg(input.kind))
  let payload = JSONValue.object([
    "total": .number(Double(roots.count)),
    "roots": .array(
      roots.map {
        .object([
          "slug": .string($0.slug), "name": .string($0.name), "kind": .string($0.kind),
          "pageCount": .number(Double($0.pageCount)),
        ])
      }),
  ])
  return encodePayload(payload)
}

private func searchSfSymbols(_ input: SearchSfSymbolsInput, _ ctx: MCPToolContext) -> MCPToolResult {
  let rows = ctx.connection.searchSfSymbols(
    query: input.query ?? "", scope: input.scope?.rawValue, limit: clampSymbolLimitInt(input.limit))
  // projectSearchSfSymbols: lean {results:[{name,scope}]} (NOT the full row).
  let payload = JSONValue.object([
    "results": .array(rows.map { .object(["name": .string($0.name), "scope": .string($0.scope)]) })
  ])
  return encodePayload(payload)
}

private func browse(_ input: BrowseInput, _ ctx: MCPToolContext) -> MCPToolResult {
  let conn = ctx.connection
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
    let children = conn.documentChildren(page.path).map { child in
      JSONValue.object([
        "path": .string(child.targetPath),
        "title": child.title.map(JSONValue.string) ?? .null,
        "section": child.section.map(JSONValue.string) ?? .null,
      ])
    }
    return encodePayload(
      .object([
        "framework": .string(root.displayName), "path": .string(path),
        "title": page.title.map(JSONValue.string) ?? .null, "children": .array(children),
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
    let groups = counts.keys.sorted(by: >).map { year in
      JSONValue.object(["year": .number(Double(year)), "count": .number(Double(counts[year]!))])
    }
    return encodePayload(
      .object([
        "framework": .string(root.displayName), "groups": .array(groups),
        "total": .number(Double(allPages.count)),
      ]))
  }

  // Flat pages — MCP passes defaultLimit 100; an explicit limit is clamped ≥ 1.
  let limit = input.limit.map { max($0, 1) } ?? 100
  let pages = Array(allPages.prefix(limit))
  var out: [String: JSONValue] = ["framework": .string(root.displayName)]
  if let year = input.year { out["year"] = .number(Double(year)) }
  out["pages"] = .array(
    pages.map { page in
      JSONValue.object([
        "path": .string(page.path),
        "title": page.title.map(JSONValue.string) ?? .null,
        "kind": (page.roleHeading ?? page.role).map(JSONValue.string) ?? .null,
        "abstract": page.abstract.map(JSONValue.string) ?? .null,
      ])
    })
  out["total"] = .number(Double(allPages.count))
  return encodePayload(.object(out))
}

/// `/^wwdc\/wwdc(\d{4})-/` → the 4-digit year (browse.js WWDC_PATH_YEAR).
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

// MARK: - helpers

private func encodePayload(_ value: JSONValue) -> MCPToolResult {
  (try? value.encoded()).map { MCPToolResult.ok(Array($0)) } ?? .failure("Failed to encode result.")
}

private func nonEmptyArg(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return value
}

/// `Math.min(Math.max(limit ?? 100 || 100, 1), 500)` (assets-symbols default 100).
private func clampSymbolLimitInt(_ value: Int?) -> Int {
  let base = (value ?? 100) == 0 ? 100 : (value ?? 100)
  return min(max(base, 1), 500)
}

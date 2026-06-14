// The ad-server MCP tool surface (RFC 0005 Phase C). Each tool's input is an ADJSON
// `@Schemable & Decodable` struct — the macro derives the JSON Schema (the zod
// replacement, D-0005-10) AND gives typed decoding; the handler calls the existing
// ADStorage queries / WebRoutes builders and projects to the exact `project*()` shapes
// (src/output/projection.js). The payload bytes flow back through the MCP dispatcher as
// `{content:[{type:text,text}], structuredContent}`.
//
// Shipped here: list_taxonomy, list_frameworks, search_sf_symbols, list_apple_fonts.
// search_docs (cascade-backed) + read_doc/render (Phase D) follow. NOTE: `@Schemable`
// today emits a STRUCTURAL schema (no descriptions/enums/bounds); those enrich when the
// ADJSON schema requirements land (R1-R3/R5). tools/call behavior is the parity gate.

import ADJSON
import ADServeCore
import ADServeDSL
import ADStorage

/// MCP `instructions` (src/mcp/server.js) — injected once per session by clients.
let mcpInstructions =
  "Local offline index of Apple developer documentation: DocC frameworks, HIG, App Store Review Guidelines, Swift Evolution/book/org, WWDC sessions, sample code, Swift packages, SF Symbols, Apple fonts. Typical flow: search_docs, then read_doc with a hit's path (paginate long pages with maxChars). browse/list_frameworks explore structure; list_taxonomy enumerates filter values. All tools are read-only and fast."

// MARK: - Input schemas (the zod replacement)

@Schemable
struct ListTaxonomyInput: Decodable {
  var field: String?
  var all: Bool?
}

@Schemable
struct ListFrameworksInput: Decodable {
  var kind: String?
  var maxChars: Int?
  var page: Int?
}

@Schemable
struct SearchSfSymbolsInput: Decodable {
  var query: String?
  var scope: String?
  var limit: Int?
}

// MARK: - Tool surface

func mcpToolRegistry() -> ToolRegistry {
  ToolRegistry {
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
      .respond { ctx in .ok(WebRoutes.fonts(ctx.connection)) }
  }
}

// MARK: - Handlers (project to the exact projection.js shapes)

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
  if let field = input.field, let match = fields.first(where: { $0.name == field }) {
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
    query: input.query ?? "", scope: nonEmptyArg(input.scope),
    limit: clampSymbolLimitInt(input.limit))
  // projectSearchSfSymbols: lean {results:[{name,scope}]} (NOT the full row).
  let payload = JSONValue.object([
    "results": .array(rows.map { .object(["name": .string($0.name), "scope": .string($0.scope)]) })
  ])
  return encodePayload(payload)
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

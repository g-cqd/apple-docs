// MCP tool surface for the documentation queries: search_docs, read_doc,
// list_frameworks, browse, list_taxonomy. They all share the doc projection
// and cache-wrap pattern; isolating them from the asset rendering tools
// keeps each surface independently reviewable.

import { z } from 'zod'
import { search } from '../../commands/search.js'
import { lookup } from '../../commands/lookup.js'
import { frameworks } from '../../commands/frameworks.js'
import { browse } from '../../commands/browse.js'
import { taxonomy } from '../../commands/taxonomy.js'
import {
  MIN_PAGINATED_MAX_CHARS,
  buildMatchedDocumentPayload,
  createMcpTextResult,
  paginateArrayField,
  paginateDocumentPayload,
} from '../pagination.js'
import {
  projectBrowse,
  projectFrameworks,
  projectReadDoc,
  projectSearchResult,
} from '../projection.js'
import { CACHE_NEGATIVE } from '../cache.js'
import {
  compactSearchHit,
  sanitizeDocumentPayload,
  validatePaginationArgs,
} from '../server/helpers.js'

// Use `z.coerce.number()` rather than `z.number()` so clients that hand-
// serialize JSON-RPC args as strings (observed: claude-code CLI sending
// `"limit": "5"`) don't trip validation. The JSON Schema exposed to the
// client is still `{ type: "number" }`; coercion only kicks in when the
// argument arrives as a numeric string.
const paginatedMaxChars = z.coerce.number().int().min(MIN_PAGINATED_MAX_CHARS)
const paginatedPage = z.coerce.number().int().min(1)

export function registerDocTools(server, ctx, cache) {
  server.tool(
    'search_docs',
    'Keyword search across all Apple documentation with fuzzy matching and tiered ranking. Use it to find APIs, symbols, articles, HIG pages, or App Store Review Guidelines. This is NOT a natural-language endpoint: pass compact, keyword-shaped queries (symbol names or API terms) and push constraints into the filter arguments (framework, source, kind, language, platform, min_*, year, track) rather than into the query string. Do not ask the user to reformulate — convert their intent yourself before calling. If the strict cascade returns nothing, the server falls back to best-effort relaxed matching (stopword pruning → OR → trigram on the strongest token); relaxed hits are tagged `matchQuality: relaxed*` and the response carries `relaxed: true` with a `relaxationTier`.',
    {
      query: z.string().describe('Compact keyword query. Prefer symbol names or API terms (e.g. "NavigationStack", "dismiss sheet", "async let") over natural-language sentences. Use the other arguments for framework/source/platform constraints instead of appending them to the query.'),
      framework: z.string().optional().describe('Filter by framework slug (e.g. swiftui, foundation, design, app-store-review)'),
      source: z.string().optional().describe('Filter by source type slug or comma-separated list (e.g. apple-docc, wwdc, sample-code)'),
      kind: z.string().optional().describe('Filter by role or displayed kind (e.g. symbol, article, Article, Session, Collection)'),
      language: z.enum(['swift', 'objc']).optional().describe('Filter by programming language'),
      platform: z.enum(['ios', 'macos', 'watchos', 'tvos', 'visionos']).optional().describe('Filter by platform availability'),
      min_ios: z.string().optional().describe('Minimum iOS version (e.g. "17.0")'),
      min_macos: z.string().optional().describe('Minimum macOS version (e.g. "14.0")'),
      min_watchos: z.string().optional().describe('Minimum watchOS version'),
      min_tvos: z.string().optional().describe('Minimum tvOS version'),
      min_visionos: z.string().optional().describe('Minimum visionOS version'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 50, hard cap 100)'),
      fuzzy: z.boolean().optional().describe('Enable typo-tolerant fuzzy matching (default true)'),
      noDeep: z.boolean().optional().describe('Disable background full-body search (default false)'),
      noEager: z.boolean().optional().describe('Wait for full-body search to complete instead of returning early (default false)'),
      read: z.boolean().optional().describe('Return the full Markdown content of the top search result instead of the result list'),
      year: z.coerce.number().optional().describe('Filter WWDC sessions by year (e.g. 2024)'),
      track: z.string().optional().describe('Filter WWDC sessions by track (e.g. SwiftUI, Accessibility)'),
      deprecated: z.enum(['include', 'exclude', 'only']).optional().describe('Deprecation filter. Default "include" returns everything with an `isDeprecated: true` flag on deprecated hits. For code-writing tasks set "exclude" to hide deprecated APIs. "only" returns just deprecated hits.'),
      maxChars: paginatedMaxChars.optional().describe(`Maximum number of characters to return in one response page (minimum ${MIN_PAGINATED_MAX_CHARS})`),
      page: paginatedPage.optional().describe('1-based page number to return when maxChars is set (default 1)'),
      match: z.string().optional().describe('Return focused match excerpts from the top read result instead of the full page content.'),
      contextChars: z.coerce.number().int().min(20).max(2000).optional().describe('Context window around each match excerpt (default 140 characters).'),
      maxMatches: z.coerce.number().int().min(1).max(50).optional().describe('Maximum number of match excerpts to return (default 5).'),
      caseSensitive: z.boolean().optional().describe('Whether match lookups should be case-sensitive (default false).'),
    },
    cache.wrap('search_docs', async (args) => {
      validatePaginationArgs(args)
      const result = await search({
        ...args,
        minIos: args.min_ios,
        minMacos: args.min_macos,
        minWatchos: args.min_watchos,
        minTvos: args.min_tvos,
        minVisionos: args.min_visionos,
      }, ctx)
      if (args.read && result.results.length > 0) {
        const hit = result.results[0]
        const page = await lookup({
          path: hit.path,
          includeSections: args.maxChars != null || args.match != null,
        }, ctx)
        let readResult = sanitizeDocumentPayload({
          found: page.found,
          bestMatch: compactSearchHit(hit, { compact: args.maxChars != null }),
          metadata: page.metadata,
          content: page.content ?? page.note ?? 'Markdown not available.',
          sections: page.sections,
          ...(page.note ? { note: page.note } : {}),
          ...(page.tierLimitation ? { tierLimitation: page.tierLimitation } : {}),
        })
        if (args.match) {
          readResult = buildMatchedDocumentPayload(readResult, {
            match: args.match,
            contextChars: args.contextChars,
            maxMatches: args.maxMatches,
            caseSensitive: args.caseSensitive,
          })
        }
        if (args.maxChars != null) {
          readResult = paginateDocumentPayload(readResult, {
            maxChars: args.maxChars,
            page: args.page,
            document: page.metadata,
          })
        }
        const projectedRead = projectReadDoc(readResult, {
          full: args.match != null || args.maxChars != null,
        })
        return createMcpTextResult(projectedRead)
      }
      const payload = args.maxChars != null
        ? paginateArrayField(result, 'results', {
            maxChars: args.maxChars,
            page: args.page,
            strategy: 'items',
          })
        : result
      const out = createMcpTextResult(projectSearchResult(payload))
      // Empty-result queries re-run the full 4-tier cascade + progressive
      // relaxation on every call. Cache misses briefly so mistypes and fuzz
      // can't burn the cascade in a tight loop.
      if (result.results.length === 0) out[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.tool(
    'read_doc',
    'Fetch the full Markdown content of a documentation page by path or symbol name. Returns declarations, parameters, platforms, and relationships. Use when you already know what you\'re looking for.',
    {
      path: z.string().optional().describe('Canonical page path (e.g. swiftui/view, design/human-interface-guidelines/accessibility, app-store-review/3.1)'),
      symbol: z.string().optional().describe('Symbol name to look up (e.g. View, Publisher, NavigationStack)'),
      framework: z.string().optional().describe('Disambiguate symbol by framework slug when multiple frameworks define the same name'),
      section: z.string().optional().describe('Extract a specific section by heading or file path (e.g. ContentView.swift). Omit to get the full document.'),
      maxChars: paginatedMaxChars.optional().describe(`Maximum number of characters to return in one response page (minimum ${MIN_PAGINATED_MAX_CHARS})`),
      page: paginatedPage.optional().describe('1-based page number to return when maxChars is set (default 1)'),
      match: z.string().optional().describe('Return focused match excerpts instead of the full document.'),
      contextChars: z.coerce.number().int().min(20).max(2000).optional().describe('Context window around each match excerpt (default 140 characters).'),
      maxMatches: z.coerce.number().int().min(1).max(50).optional().describe('Maximum number of match excerpts to return (default 5).'),
      caseSensitive: z.boolean().optional().describe('Whether match lookups should be case-sensitive (default false).'),
    },
    cache.wrap('read_doc', async (args) => {
      validatePaginationArgs(args)
      const result = await lookup({
        ...args,
        includeSections: args.maxChars != null || args.match != null,
      }, ctx)
      let payload = sanitizeDocumentPayload(result)
      if (args.match) {
        payload = buildMatchedDocumentPayload(payload, {
          match: args.match,
          contextChars: args.contextChars,
          maxMatches: args.maxMatches,
          caseSensitive: args.caseSensitive,
        })
      }
      if (args.maxChars != null) {
        payload = paginateDocumentPayload(payload, {
          maxChars: args.maxChars,
          page: args.page,
          document: result.metadata,
        })
      }
      const full = args.section != null || args.match != null || args.maxChars != null
      const out = createMcpTextResult(projectReadDoc(payload, { full }))
      // 404-style lookups (typo'd path/symbol) are re-scanned on every call;
      // short-TTL cache them so pathological clients don't keep burning the
      // disk/DB path.
      if (result?.found === false) out[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.tool(
    'list_frameworks',
    'List all indexed documentation roots — frameworks, technologies, HIG, tooling, release notes, and App Store Review Guidelines — with page counts and status. Use to discover what\'s available.',
    {
      kind: z.string().optional().describe('Filter by kind: framework, technology, tooling, release-notes, tutorial, guidelines'),
      maxChars: paginatedMaxChars.optional().describe(`Maximum number of characters to return in one response page (minimum ${MIN_PAGINATED_MAX_CHARS})`),
      page: paginatedPage.optional().describe('1-based page number to return when maxChars is set (default 1)'),
    },
    cache.wrap('list_frameworks', async (args) => {
      validatePaginationArgs(args)
      const result = await frameworks(args, ctx)
      const payload = args.maxChars != null
        ? paginateArrayField(result, 'roots', {
            maxChars: args.maxChars,
            page: args.page,
            strategy: 'items',
          })
        : result
      return createMcpTextResult(projectFrameworks(payload))
    }),
  )

  server.tool(
    'browse',
    'Explore the documentation topic tree. Lists all pages in a framework, or drills into a specific page to show its children and references.',
    {
      framework: z.string().describe('Framework slug (e.g. swiftui, combine, design, app-store-review)'),
      path: z.string().optional().describe('Page path to show children of (e.g. swiftui/view, design/human-interface-guidelines/components)'),
      limit: z.coerce.number().int().min(1).max(200).optional().describe('Max pages to return when listing a full framework (hard cap 200; default: all)'),
      maxChars: paginatedMaxChars.optional().describe(`Maximum number of characters to return in one response page (minimum ${MIN_PAGINATED_MAX_CHARS})`),
      page: paginatedPage.optional().describe('1-based page number to return when maxChars is set (default 1)'),
    },
    cache.wrap('browse', async (args) => {
      validatePaginationArgs(args)
      const result = await browse(args, ctx)
      if (args.maxChars == null) {
        return createMcpTextResult(projectBrowse(result))
      }
      const fieldName = args.path ? 'children' : 'pages'
      const payload = paginateArrayField(result, fieldName, {
        maxChars: args.maxChars,
        page: args.page,
        strategy: 'items',
      })
      return createMcpTextResult(projectBrowse(payload))
    }),
  )

  server.tool(
    'list_taxonomy',
    'List distinct taxonomy values (kind, role, docKind, roleHeading, sourceType) across the corpus with counts. Use this before calling search_docs when you need to pick a valid `kind` filter or understand what shapes of documentation are indexed. Static between `apple-docs update` runs.',
    {
      field: z.enum(['kind', 'role', 'docKind', 'roleHeading', 'sourceType']).optional().describe('Return a single field instead of all five.'),
    },
    cache.wrap('list_taxonomy', async (args) => {
      const result = await taxonomy(args, ctx)
      return createMcpTextResult(result)
    }),
  )
}

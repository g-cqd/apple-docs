import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// The official MCP SDK is the single sanctioned npm dependency.
// It handles JSON-RPC 2.0, schema validation, transport negotiation,
// and protocol compliance — replacing the hand-rolled server.

import { search } from '../commands/search.js'
import { lookup } from '../commands/lookup.js'
import { frameworks } from '../commands/frameworks.js'
import { browse } from '../commands/browse.js'
import { taxonomy } from '../commands/taxonomy.js'
import {
  MIN_PAGINATED_MAX_CHARS,
  buildMatchedDocumentPayload,
  createMcpTextResult,
  paginateArrayField,
  paginateDocumentPayload,
} from './pagination.js'
import { coerceSection } from '../content/coercion.js'
import {
  projectSearchResult,
  projectReadDoc,
  projectFrameworks,
  projectBrowse,
} from './projection.js'
import { CACHE_NEGATIVE, createCacheRegistry } from './cache.js'

// Use `z.coerce.number()` rather than `z.number()` so clients that hand-
// serialize JSON-RPC args as strings (observed: claude-code CLI sending
// `"limit": "5"`) don't trip validation. The JSON Schema exposed to the
// client is still `{ type: "number" }`; coercion only kicks in when the
// argument arrives as a numeric string.
const paginatedMaxChars = z.coerce.number().int().min(MIN_PAGINATED_MAX_CHARS)
const paginatedPage = z.coerce.number().int().min(1)

/**
 * Create an MCP server instance with all tools and resources registered.
 * Separated from startServer() so tests can create a server without stdio.
 *
 * @param {object} ctx - shared command context ({ db, dataDir, logger, ... })
 * @param {object} [deps] - optional injection points
 * @param {object} [deps.cacheRegistry] - pre-built cache registry. HTTP mode
 *   passes one shared registry so cache hits survive across requests; stdio
 *   mode omits it and we create one per process.
 */
export function createServer(ctx, deps = {}) {
  const server = new McpServer(
    { name: 'apple-docs', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  )

  const cache = deps.cacheRegistry ?? createCacheRegistry(ctx)

  // --- Tools ---

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
      limit: z.coerce.number().optional().describe('Max results (default 100)'),
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
      limit: z.coerce.number().optional().describe('Max pages to return when listing a full framework (default: all)'),
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

  // --- Resources ---

  server.resource(
    'doc',
    new ResourceTemplate('apple-docs://doc/{+key}', { list: undefined }),
    { description: 'Read a documentation page by key', mimeType: 'text/markdown' },
    async (uri, { key }) => {
      const result = await lookup({ path: key }, ctx)
      const projected = projectReadDoc(sanitizeDocumentPayload(result), { full: false })
      const text = projected.found === false
        ? (projected.note ?? 'Not found')
        : (result.content ?? result.note ?? 'Not found')
      return {
        contents: [{
          uri: uri.href,
          text,
          mimeType: 'text/markdown',
        }],
      }
    },
  )

  server.resource(
    'framework',
    new ResourceTemplate('apple-docs://framework/{slug}', {
      list: async () => {
        const result = projectFrameworks(await frameworks({}, ctx))
        return {
          resources: result.roots.map((r) => ({
            uri: `apple-docs://framework/${r.slug}`,
            name: r.name ?? r.slug,
          })),
        }
      },
    }),
    { description: 'Browse a framework topic tree', mimeType: 'application/json' },
    async (uri, { slug }) => {
      const { maxChars, page } = parseResourcePagination(uri)
      const result = await browse({ framework: String(slug).split('?')[0] }, ctx)
      const payload = maxChars == null
        ? result
        : paginateArrayField(result, 'pages', {
            maxChars,
            page,
            strategy: 'items',
          })
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(projectBrowse(payload), null, 2),
          mimeType: 'application/json',
        }],
      }
    },
  )

  return server
}

/**
 * Start the MCP server, connecting via stdio transport.
 */
export async function startServer(ctx, opts = {}) {
  const { logger } = ctx
  const createServerImpl = opts.createServer ?? createServer
  const createTransport = opts.createTransport ?? (() => new StdioServerTransport())
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  logger.info('MCP server starting (SDK)...')
  const server = createServerImpl(ctx)
  const transport = createTransport()

  let closedResolve = null
  const closed = new Promise(resolve => { closedResolve = resolve })
  let closePromise = null

  const detachListeners = () => {
    stdin.off?.('end', onStdinEnd)
    stdin.off?.('close', onStdinClose)
    stdout.off?.('error', onStdoutError)
    stderr.off?.('error', onStderrError)
  }

  const close = (reason = 'shutdown') => {
    if (closePromise) return closePromise
    detachListeners()
    closePromise = (async () => {
      try {
        if (typeof server.close === 'function') {
          await server.close()
        } else {
          await transport.close?.()
        }
      } catch (error) {
        logger?.warn?.(`MCP server close failed: ${error?.message ?? error}`)
        try {
          await transport.close?.()
        } catch (transportError) {
          logger?.warn?.(`MCP transport close failed: ${transportError?.message ?? transportError}`)
        }
      }
      return reason
    })()
    closePromise.finally(() => { closedResolve?.(reason) })
    return closePromise
  }

  const closeOnPipeEnd = (reason) => {
    logger?.info?.(`MCP stdio disconnected (${reason})`)
    void close(reason)
  }

  const closeOnPipeError = (streamName, error) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
      closeOnPipeEnd(`${streamName}:${error.code}`)
      return
    }
    logger?.error?.(`MCP ${streamName} stream error: ${error?.message ?? error}`, { stack: error?.stack })
  }

  const onStdinEnd = () => closeOnPipeEnd('stdin:end')
  const onStdinClose = () => closeOnPipeEnd('stdin:close')
  const onStdoutError = (error) => closeOnPipeError('stdout', error)
  const onStderrError = (error) => closeOnPipeError('stderr', error)

  stdin.on?.('end', onStdinEnd)
  stdin.on?.('close', onStdinClose)
  stdout.on?.('error', onStdoutError)
  stderr.on?.('error', onStderrError)

  try {
    await server.connect(transport)
  } catch (error) {
    detachListeners()
    throw error
  }

  return { server, transport, close, closed }
}

function sanitizeDocumentPayload(payload) {
  if (!Array.isArray(payload?.sections) || payload.sections.length === 0) return payload
  return {
    ...payload,
    sections: payload.sections.map(section => coerceSection(section)),
  }
}

function validatePaginationArgs(args) {
  if (args.page != null && args.maxChars == null) {
    throw new Error('The page parameter requires maxChars.')
  }
}

function parseResourcePagination(uri) {
  const maxCharsValue = uri.searchParams.get('maxChars')
  const pageValue = uri.searchParams.get('page')
  const maxChars = maxCharsValue == null ? null : Number.parseInt(maxCharsValue, 10)
  const page = pageValue == null ? 1 : Number.parseInt(pageValue, 10)

  if (Number.isNaN(maxChars)) {
    throw new Error('Invalid maxChars query parameter.')
  }
  if (Number.isNaN(page) || page < 1) {
    throw new Error('Invalid page query parameter.')
  }
  if (pageValue != null && maxCharsValue == null) {
    throw new Error('The page query parameter requires maxChars.')
  }
  if (maxChars != null && maxChars < MIN_PAGINATED_MAX_CHARS) {
    throw new Error(`maxChars must be at least ${MIN_PAGINATED_MAX_CHARS}.`)
  }

  return { maxChars, page }
}

function compactSearchHit(hit, opts = {}) {
  const { compact = false } = opts
  const result = {
    title: hit?.title ?? null,
    framework: hit?.framework ?? null,
    rootSlug: hit?.rootSlug ?? null,
    kind: hit?.kind ?? null,
    path: hit?.path ?? null,
    matchQuality: hit?.matchQuality ?? null,
  }

  if (!compact) {
    result.sourceType = hit?.sourceType ?? null
    result.sourceMetadata = hit?.sourceMetadata ?? null
    result.abstract = hit?.abstract ?? null
    result.platforms = hit?.platforms ?? []
    result.declaration = hit?.declaration ?? null
    result.urlDepth = hit?.urlDepth ?? 0
    result.isReleaseNotes = hit?.isReleaseNotes ?? false
    result.language = hit?.language ?? null
    result.snippet = hit?.snippet ?? null
    result.relatedCount = hit?.relatedCount ?? null
    if (hit?.isDeprecated) result.isDeprecated = true
    if (hit?.isBeta) result.isBeta = true
  }

  return result
}

// MCP tool surface for the documentation queries: search_docs, read_doc,
// list_frameworks, browse, list_taxonomy. Every response routes through
// src/output/projection.js before serialisation; nothing else in this
// file is allowed to shape the public payload.

import { z } from 'zod'
import { browse } from '../../commands/browse.js'
import { frameworks } from '../../commands/frameworks.js'
import { lookup } from '../../commands/lookup.js'
import { search } from '../../commands/search.js'
import { taxonomy } from '../../commands/taxonomy.js'
import { projectBrowse, projectFrameworks, projectReadDoc, projectSearchResult, projectTaxonomy } from '../../output/projection.js'
import { CACHE_NEGATIVE } from '../cache.js'
import { buildMatchedDocumentPayload, createMcpTextResult, MIN_PAGINATED_MAX_CHARS, paginateArrayField, paginateDocumentPayload } from '../pagination.js'
import { sanitizeDocumentPayload, validatePaginationArgs } from '../server/helpers.js'

// Tool definitions are deliberately lean: no outputSchema (it tripled the
// tools/list payload an MCP client loads into model context; the projection
// layer + leak-guard tests are the real output gate) and terse, verb-first
// descriptions. Budget regressions are caught by test/mcp/contract.test.js.
//
// `z.coerce.number()` accepts numeric strings — observed: claude-code CLI
// sends `"limit": "5"`. The exposed JSON Schema is still `{ type: "number" }`.
const paginatedMaxChars = z.coerce.number().int().min(MIN_PAGINATED_MAX_CHARS)
const paginatedPage = z.coerce.number().int().min(1)

// Shared pagination fields — spread into every tool that paginates so the
// schema + descriptions stay identical across search_docs and read_doc.
const paginationShape = {
  maxChars: paginatedMaxChars.optional().describe(`Page size in chars (min ${MIN_PAGINATED_MAX_CHARS}).`),
  page: paginatedPage.optional().describe('1-based page; needs maxChars.'),
}

// every doc tool is read-only and idempotent.
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

const minVersionSchema = z
  .object({
    ios: z.string().optional(),
    macos: z.string().optional(),
    watchos: z.string().optional(),
    tvos: z.string().optional(),
    visionos: z.string().optional(),
  })
  .optional()
  .describe('Min version per platform, e.g. {"ios":"17.0"}.')

const matchExcerptSchema = z
  .object({
    query: z.string().describe('Substring to locate.'),
    context: z.coerce.number().int().min(20).max(2000).optional().describe('Chars around each match (default 140).'),
    max: z.coerce.number().int().min(1).max(50).optional().describe('Max excerpts (default 5).'),
    caseSensitive: z.boolean().optional(),
  })
  .optional()
  .describe('Return only excerpt windows around matches instead of full content.')

/**
 * @param {any} server
 * @param {any} ctx
 * @param {{ wrap: (name: string, fn: (args: any) => any) => any }} cache
 */
export function registerDocTools(server, ctx, cache) {
  server.registerTool(
    'search_docs',
    {
      description:
        "Search Apple developer docs (keyword + semantic). Prefer compact symbol/API terms; put constraints in filter args, not the query. Set read=true to inline the top hit's content.",
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        query: z.string().describe('Search terms, e.g. "NavigationStack".'),
        framework: z.string().optional().describe('Framework slug, e.g. swiftui, app-store-review.'),
        source: z.string().optional().describe('Source slug(s), comma-separated: apple-docc, hig, wwdc, sample-code, swift-evolution, ...'),
        kind: z.string().optional().describe('Page kind (values via list_taxonomy).'),
        language: z.enum(['swift', 'objc']).optional(),
        platform: z.enum(['ios', 'macos', 'watchos', 'tvos', 'visionos']).optional(),
        minVersion: minVersionSchema,
        limit: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
        read: z.boolean().optional().describe("Inline the top result's full content."),
        year: z.coerce.number().optional().describe('WWDC session year.'),
        track: z.string().optional().describe('WWDC track.'),
        deprecated: z.enum(['include', 'exclude', 'only']).optional().describe('Default include; use exclude when writing code.'),
        ...paginationShape,
        match: matchExcerptSchema,
      },
    },
    cache.wrap('search_docs', async (args) => {
      validatePaginationArgs(args)
      const { minVersion = {}, match: matchOpts, ...rest } = args
      const result = await search(
        {
          ...rest,
          // Leaner MCP default than the CLI's 50 — agents page or raise limit
          // when they actually need more (Anthropic tool-writing guidance).
          limit: rest.limit ?? 25,
          minIos: minVersion.ios,
          minMacos: minVersion.macos,
          minWatchos: minVersion.watchos,
          minTvos: minVersion.tvos,
          minVisionos: minVersion.visionos,
        },
        ctx,
      )

      if (args.read && result.results.length > 0) {
        const hit = result.results[0]
        const includeSections = args.maxChars != null || matchOpts != null
        const page = await lookup({ path: hit.path, includeSections }, ctx)
        let readResult = sanitizeDocumentPayload({
          found: page.found,
          bestMatch: hit,
          metadata: page.metadata,
          content: page.content ?? page.note ?? 'Markdown not available.',
          sections: page.sections,
          ...(page.note ? { note: page.note } : {}),
        })
        if (matchOpts) {
          readResult = buildMatchedDocumentPayload(readResult, {
            match: matchOpts.query,
            contextChars: matchOpts.context,
            maxMatches: matchOpts.max,
            caseSensitive: matchOpts.caseSensitive,
          })
        }
        if (args.maxChars != null) {
          readResult = paginateDocumentPayload(readResult, {
            maxChars: args.maxChars,
            page: args.page,
            document: page.metadata,
          })
        }
        const full = matchOpts != null || args.maxChars != null
        return createMcpTextResult(projectReadDoc(readResult, { full }))
      }

      const payload =
        args.maxChars != null
          ? paginateArrayField(result, 'results', {
              maxChars: args.maxChars,
              page: args.page,
              strategy: 'items',
            })
          : result
      const out = createMcpTextResult(projectSearchResult(payload))
      // Cache empty results briefly so the cascade isn't burned in a tight loop.
      if (result.results.length === 0) /** @type {any} */ (out)[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.registerTool(
    'read_doc',
    {
      description:
        'Read a documentation page as Markdown, by path or symbol name. Long pages: pass maxChars to paginate, section for one section, or match for excerpts.',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        path: z.string().optional().describe('Page path, e.g. swiftui/view, app-store-review/3.1.'),
        symbol: z.string().optional().describe('Symbol name, e.g. NavigationStack.'),
        framework: z.string().optional().describe('Disambiguates symbol.'),
        section: z.string().optional().describe('Single section by heading.'),
        ...paginationShape,
        match: matchExcerptSchema,
      },
    },
    cache.wrap('read_doc', async (args) => {
      validatePaginationArgs(args)
      const matchOpts = args.match
      const result = await lookup(
        {
          ...args,
          includeSections: args.maxChars != null || matchOpts != null,
        },
        ctx,
      )
      let payload = sanitizeDocumentPayload(result)
      if (matchOpts) {
        payload = buildMatchedDocumentPayload(payload, {
          match: matchOpts.query,
          contextChars: matchOpts.context,
          maxMatches: matchOpts.max,
          caseSensitive: matchOpts.caseSensitive,
        })
      }
      if (args.maxChars != null) {
        payload = paginateDocumentPayload(payload, {
          maxChars: args.maxChars,
          page: args.page,
          document: result.metadata,
        })
      }
      const full = args.section != null || matchOpts != null || args.maxChars != null
      const out = createMcpTextResult(projectReadDoc(payload, { full }))
      if (result?.found === false) /** @type {any} */ (out)[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.registerTool(
    'list_frameworks',
    {
      description: 'List indexed documentation roots (frameworks, HIG, guidelines, WWDC, tooling, ...) with page counts.',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        kind: z.string().optional().describe('Filter: framework, technology, tooling, collection, release-notes, tutorial, guidelines, design.'),
        ...paginationShape,
      },
    },
    cache.wrap('list_frameworks', async (args) => {
      validatePaginationArgs(args)
      const result = await frameworks(args, ctx)
      const payload =
        args.maxChars != null
          ? paginateArrayField(result, 'roots', {
              maxChars: args.maxChars,
              page: args.page,
              strategy: 'items',
            })
          : result
      return createMcpTextResult(projectFrameworks(payload))
    }),
  )

  server.registerTool(
    'browse',
    {
      description:
        "Walk the documentation topic tree: a root's pages, or one page's children via path. wwdc root returns per-year groups; pass year for that year's sessions.",
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        framework: z.string().describe('Root slug, e.g. swiftui, design, wwdc.'),
        path: z.string().optional().describe('Drill into a page, e.g. swiftui/view.'),
        year: z.coerce.number().int().optional().describe('WWDC sessions of one year.'),
        limit: z.coerce.number().int().min(1).max(200).optional().describe('Max pages (default 100, cap 200).'),
        ...paginationShape,
      },
    },
    cache.wrap('browse', async (args) => {
      validatePaginationArgs(args)
      // The browse command is unbounded by default (fine for CLI/web); an
      // unbounded root listing through MCP can dump thousands of pages into
      // the model's context. defaultLimit bounds flat listings while still
      // letting scope-aware shapes (WWDC year groups) through.
      const result = await browse({ ...args, defaultLimit: 100 }, ctx)
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

  server.registerTool(
    'list_taxonomy',
    {
      description: 'List distinct taxonomy values with counts (top 20 per field). Use to pick valid search_docs kind filters.',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        field: z.enum(['kind', 'role', 'docKind', 'roleHeading', 'sourceType']).optional().describe('Single field instead of all five.'),
        all: z.boolean().optional().describe('Full distribution, not top 20.'),
      },
    },
    cache.wrap('list_taxonomy', async (args) => {
      const result = await taxonomy(args, ctx)
      return createMcpTextResult(projectTaxonomy(result))
    }),
  )
}

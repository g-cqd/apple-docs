// MCP tool surface for the documentation queries: search_docs, read_doc,
// list_frameworks, browse, list_taxonomy. Every response routes through
// src/output/projection.js before serialisation; nothing else in this
// file is allowed to shape the public payload.

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
  projectTaxonomy,
} from '../../output/projection.js'
import { CACHE_NEGATIVE } from '../cache.js'
import {
  browseOutputSchema,
  listFrameworksOutputSchema,
  listTaxonomyOutputSchema,
  readDocOutputSchema,
  searchDocsOutputSchema,
} from '../../output/schemas.js'
import {
  sanitizeDocumentPayload,
  validatePaginationArgs,
} from '../server/helpers.js'

// `z.coerce.number()` accepts numeric strings — observed: claude-code CLI
// sends `"limit": "5"`. The exposed JSON Schema is still `{ type: "number" }`.
const paginatedMaxChars = z.coerce.number().int().min(MIN_PAGINATED_MAX_CHARS)
const paginatedPage = z.coerce.number().int().min(1)

// every doc tool is read-only and idempotent.
const READ_ONLY_HINTS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

const minVersionSchema = z.object({
  ios: z.string().optional(),
  macos: z.string().optional(),
  watchos: z.string().optional(),
  tvos: z.string().optional(),
  visionos: z.string().optional(),
}).optional().describe('Minimum version per platform, e.g. { ios: "17.0" }.')

const matchExcerptSchema = z.object({
  query: z.string().describe('Substring to find within document content.'),
  context: z.coerce.number().int().min(20).max(2000).optional().describe('Context window per excerpt (default 140 chars).'),
  max: z.coerce.number().int().min(1).max(50).optional().describe('Max excerpts (default 5).'),
  caseSensitive: z.boolean().optional().describe('Case-sensitive lookup (default false).'),
}).optional().describe('Focused match excerpts from document content.')

export function registerDocTools(server, ctx, cache) {
  server.registerTool(
    'search_docs',
    {
      description: 'Keyword search across Apple docs. Pass compact symbol/API terms — not natural language. Use filter args (framework, source, kind, language, platform, minVersion, year, track, deprecated) instead of appending constraints to the query. Empty results may fall back to approximate matching — flagged in the response.',
      annotations: READ_ONLY_HINTS,
      outputSchema: searchDocsOutputSchema,
      inputSchema: {
        query: z.string().describe('Compact keyword query (symbol or API term).'),
        framework: z.string().optional().describe('Framework slug (e.g. swiftui, foundation, app-store-review).'),
        source: z.string().optional().describe('Source slug or comma-separated list (apple-docc, wwdc, sample-code, ...).'),
        kind: z.string().optional().describe('Role or displayed kind (use list_taxonomy to discover values).'),
        language: z.enum(['swift', 'objc']).optional().describe('Language filter.'),
        platform: z.enum(['ios', 'macos', 'watchos', 'tvos', 'visionos']).optional().describe('Platform availability.'),
        minVersion: minVersionSchema,
        limit: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 50, cap 100).'),
        read: z.boolean().optional().describe('Return the top result\'s full content instead of the list.'),
        year: z.coerce.number().optional().describe('Filter WWDC sessions by year.'),
        track: z.string().optional().describe('Filter WWDC sessions by track.'),
        deprecated: z.enum(['include', 'exclude', 'only']).optional().describe('Deprecation filter (default include; pass exclude for code-writing tasks).'),
        maxChars: paginatedMaxChars.optional().describe(`Max characters per response page (minimum ${MIN_PAGINATED_MAX_CHARS}).`),
        page: paginatedPage.optional().describe('1-based page number (requires maxChars).'),
        match: matchExcerptSchema,
      },
    },
    cache.wrap('search_docs', async (args) => {
      validatePaginationArgs(args)
      const { minVersion = {}, match: matchOpts, ...rest } = args
      const result = await search({
        ...rest,
        minIos: minVersion.ios,
        minMacos: minVersion.macos,
        minWatchos: minVersion.watchos,
        minTvos: minVersion.tvos,
        minVisionos: minVersion.visionos,
      }, ctx)

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

      const payload = args.maxChars != null
        ? paginateArrayField(result, 'results', {
            maxChars: args.maxChars,
            page: args.page,
            strategy: 'items',
          })
        : result
      const out = createMcpTextResult(projectSearchResult(payload))
      // Cache empty results briefly so the cascade isn't burned in a tight loop.
      if (result.results.length === 0) out[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.registerTool(
    'read_doc',
    {
      description: 'Fetch the full Markdown content of a documentation page by path or symbol name. Returns declarations, parameters, platforms, and a `relationships` count (inherits-from, conforms-to, see-also, children) on the metadata. Use when you already know what you\'re looking for.',
      annotations: READ_ONLY_HINTS,
      outputSchema: readDocOutputSchema,
      inputSchema: {
        path: z.string().optional().describe('Canonical page path (e.g. swiftui/view, app-store-review/3.1).'),
        symbol: z.string().optional().describe('Symbol name (e.g. View, Publisher, NavigationStack).'),
        framework: z.string().optional().describe('Disambiguate symbol when multiple frameworks share the name.'),
        section: z.string().optional().describe('Extract a specific section by heading or file path.'),
        maxChars: paginatedMaxChars.optional().describe(`Max characters per response page (minimum ${MIN_PAGINATED_MAX_CHARS}).`),
        page: paginatedPage.optional().describe('1-based page number (requires maxChars).'),
        match: matchExcerptSchema,
      },
    },
    cache.wrap('read_doc', async (args) => {
      validatePaginationArgs(args)
      const matchOpts = args.match
      const result = await lookup({
        ...args,
        includeSections: args.maxChars != null || matchOpts != null,
      }, ctx)
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
      if (result?.found === false) out[CACHE_NEGATIVE] = true
      return out
    }),
  )

  server.registerTool(
    'list_frameworks',
    {
      description: 'List all indexed documentation roots — frameworks, technologies, HIG, tooling, release notes, App Store Review Guidelines — with page counts. Returns the full set by default; pass `kind` to filter.',
      annotations: READ_ONLY_HINTS,
      outputSchema: listFrameworksOutputSchema,
      inputSchema: {
        kind: z.string().optional().describe('Filter by kind (framework, technology, tooling, release-notes, tutorial, guidelines).'),
        maxChars: paginatedMaxChars.optional().describe(`Max characters per response page (minimum ${MIN_PAGINATED_MAX_CHARS}).`),
        page: paginatedPage.optional().describe('1-based page number (requires maxChars).'),
      },
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

  server.registerTool(
    'browse',
    {
      description: 'Explore the documentation topic tree. Lists all pages in a framework, or drills into a specific page to show its children.',
      annotations: READ_ONLY_HINTS,
      outputSchema: browseOutputSchema,
      inputSchema: {
        framework: z.string().describe('Framework slug (e.g. swiftui, combine, design, app-store-review).'),
        path: z.string().optional().describe('Page path to drill into (e.g. swiftui/view).'),
        limit: z.coerce.number().int().min(1).max(200).optional().describe('Max pages when listing a full framework (cap 200).'),
        maxChars: paginatedMaxChars.optional().describe(`Max characters per response page (minimum ${MIN_PAGINATED_MAX_CHARS}).`),
        page: paginatedPage.optional().describe('1-based page number (requires maxChars).'),
      },
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

  server.registerTool(
    'list_taxonomy',
    {
      description: 'List distinct taxonomy values (kind, role, docKind, roleHeading, sourceType) across the corpus with counts. Use before search_docs to pick a valid `kind` filter. Default returns the top 20 per field; pass `all: true` for the full distribution.',
      annotations: READ_ONLY_HINTS,
      outputSchema: listTaxonomyOutputSchema,
      inputSchema: {
        field: z.enum(['kind', 'role', 'docKind', 'roleHeading', 'sourceType']).optional().describe('Return a single field instead of all five.'),
        all: z.boolean().optional().describe('Return every distinct value (default: top 20 per field).'),
      },
    },
    cache.wrap('list_taxonomy', async (args) => {
      const result = await taxonomy(args, ctx)
      return createMcpTextResult(projectTaxonomy(result))
    }),
  )
}

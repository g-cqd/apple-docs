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
import { status } from '../commands/status.js'

/**
 * Create an MCP server instance with all tools and resources registered.
 * Separated from startServer() so tests can create a server without stdio.
 */
export function createServer(ctx) {
  const server = new McpServer(
    { name: 'apple-docs', version: '2.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  )

  // --- Tools ---

  server.tool(
    'search_docs',
    'Full-text search across all Apple documentation with fuzzy matching and tiered ranking. Use to find APIs, symbols, articles, HIG pages, or App Store Review Guidelines by keyword.',
    {
      query: z.string().describe('Search query (symbol name, API term, or natural language)'),
      framework: z.string().optional().describe('Filter by framework slug (e.g. swiftui, foundation, design, app-store-review)'),
      source: z.string().optional().describe('Filter by source type slug or comma-separated list (e.g. apple-docc, wwdc, sample-code)'),
      kind: z.string().optional().describe('Filter by role (e.g. symbol, article, collection)'),
      language: z.enum(['swift', 'objc']).optional().describe('Filter by programming language'),
      platform: z.enum(['ios', 'macos', 'watchos', 'tvos', 'visionos']).optional().describe('Filter by platform availability'),
      min_ios: z.string().optional().describe('Minimum iOS version (e.g. "17.0")'),
      min_macos: z.string().optional().describe('Minimum macOS version (e.g. "14.0")'),
      min_watchos: z.string().optional().describe('Minimum watchOS version'),
      min_tvos: z.string().optional().describe('Minimum tvOS version'),
      min_visionos: z.string().optional().describe('Minimum visionOS version'),
      limit: z.number().optional().describe('Max results (default 100)'),
      fuzzy: z.boolean().optional().describe('Enable typo-tolerant fuzzy matching (default true)'),
      noDeep: z.boolean().optional().describe('Disable background full-body search (default false)'),
      noEager: z.boolean().optional().describe('Wait for full-body search to complete instead of returning early (default false)'),
      read: z.boolean().optional().describe('Return the full Markdown content of the top search result instead of the result list'),
    },
    async (args) => {
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
        const page = await lookup({ path: hit.path }, ctx)
        return {
          content: [{ type: 'text', text: JSON.stringify({ bestMatch: hit, content: page.content ?? page.note ?? 'Markdown not available.' }, null, 2) }],
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'read_doc',
    'Fetch the full Markdown content of a documentation page by path or symbol name. Returns declarations, parameters, platforms, and relationships. Use when you already know what you\'re looking for.',
    {
      path: z.string().optional().describe('Canonical page path (e.g. swiftui/view, design/human-interface-guidelines/accessibility, app-store-review/3.1)'),
      symbol: z.string().optional().describe('Symbol name to look up (e.g. View, Publisher, NavigationStack)'),
      framework: z.string().optional().describe('Disambiguate symbol by framework slug when multiple frameworks define the same name'),
    },
    async (args) => {
      const result = await lookup(args, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'list_frameworks',
    'List all indexed documentation roots — frameworks, technologies, HIG, tooling, release notes, and App Store Review Guidelines — with page counts and status. Use to discover what\'s available.',
    {
      kind: z.string().optional().describe('Filter by kind: framework, technology, tooling, release-notes, tutorial, guidelines'),
    },
    async (args) => {
      const result = await frameworks(args, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'browse',
    'Explore the documentation topic tree. Lists all pages in a framework, or drills into a specific page to show its children and references.',
    {
      framework: z.string().describe('Framework slug (e.g. swiftui, combine, design, app-store-review)'),
      path: z.string().optional().describe('Page path to show children of (e.g. swiftui/view, design/human-interface-guidelines/components)'),
      limit: z.number().optional().describe('Max pages to return when listing a full framework (default: all)'),
    },
    async (args) => {
      const result = await browse(args, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'status',
    'Show corpus health: total pages, frameworks by kind, disk usage, crawl progress, and last sync time.',
    {},
    async () => {
      const result = await status({}, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'search_wwdc',
    'Search WWDC session transcripts by keyword, year, or track. Returns session titles, descriptions, and transcript excerpts.',
    {
      query: z.string().describe('Search query (topic, API name, or keyword)'),
      year: z.number().optional().describe('Filter by WWDC year (e.g. 2024)'),
      track: z.string().optional().describe('Filter by track (e.g. SwiftUI, UIKit, Accessibility)'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async (args) => {
      const searchArgs = {
        query: args.query,
        framework: 'wwdc',
        limit: args.limit ?? 10,
      }
      const result = await search(searchArgs, ctx)
      // Post-filter by year/track from sourceMetadata
      let filtered = result.results
      if (args.year || args.track) {
        filtered = filtered.filter(r => {
          try {
            const meta = JSON.parse(r.sourceMetadata ?? r.source_metadata ?? '{}')
            if (args.year && meta.year !== args.year) return false
            if (args.track && meta.track && !meta.track.toLowerCase().includes(args.track.toLowerCase())) return false
            return true
          } catch { return true }
        })
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, results: filtered }, null, 2) }] }
    },
  )

  server.tool(
    'search_samples',
    'Search Apple sample code projects by keyword or framework. Returns project titles, descriptions, and associated frameworks.',
    {
      query: z.string().describe('Search query (project name, topic, or framework)'),
      framework: z.string().optional().describe('Filter by framework (e.g. swiftui, arkit, realitykit)'),
      limit: z.number().optional().describe('Max results (default 10)'),
    },
    async (args) => {
      const searchArgs = {
        query: args.query,
        kind: 'sample-project',
        limit: args.limit ?? 10,
      }
      if (args.framework) searchArgs.framework = args.framework
      const result = await search(searchArgs, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  server.tool(
    'read_sample_file',
    'Read a specific file from an Apple sample code project. Provide the sample key and file path.',
    {
      sample_key: z.string().describe('Sample code project key (e.g. sample-code/swiftui/food-truck)'),
      file_path: z.string().optional().describe('Specific file path within the project. Omit to get the project overview.'),
    },
    async (args) => {
      const result = await lookup({ path: args.sample_key }, ctx)
      if (args.file_path && result.sections) {
        const fileSection = result.sections.find(s =>
          s.heading === args.file_path || s.heading?.endsWith(args.file_path),
        )
        if (fileSection) {
          return { content: [{ type: 'text', text: fileSection.content_text ?? fileSection.contentText ?? 'File content not available.' }] }
        }
        return { content: [{ type: 'text', text: `File not found: ${args.file_path}` }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    },
  )

  // --- Resources ---

  server.resource(
    'doc',
    new ResourceTemplate('apple-docs://doc/{+key}', { list: undefined }),
    { description: 'Read a documentation page by key', mimeType: 'text/markdown' },
    async (uri, { key }) => {
      const result = await lookup({ path: key }, ctx)
      return {
        contents: [{
          uri: uri.href,
          text: result.content ?? result.note ?? 'Not found',
          mimeType: 'text/markdown',
        }],
      }
    },
  )

  server.resource(
    'framework',
    new ResourceTemplate('apple-docs://framework/{slug}', {
      list: async () => {
        const result = await frameworks({}, ctx)
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
      const result = await browse({ framework: slug }, ctx)
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(result, null, 2),
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
export async function startServer(ctx) {
  const { logger } = ctx
  logger.info('MCP server starting (SDK)...')
  const server = createServer(ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

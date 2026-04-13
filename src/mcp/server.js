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
    { name: 'apple-docs', version: '1.0.0' },
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
      year: z.number().optional().describe('Filter WWDC sessions by year (e.g. 2024)'),
      track: z.string().optional().describe('Filter WWDC sessions by track (e.g. SwiftUI, Accessibility)'),
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
        const readResult = {
          bestMatch: hit,
          content: page.content ?? page.note ?? 'Markdown not available.',
          ...(page.tierLimitation ? { tierLimitation: page.tierLimitation } : {}),
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(readResult, null, 2) }],
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
      section: z.string().optional().describe('Extract a specific section by heading or file path (e.g. ContentView.swift). Omit to get the full document.'),
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
      const result = await status({ skipUpdateCheck: true }, ctx)
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

import { search } from '../commands/search.js'
import { lookup } from '../commands/lookup.js'
import { frameworks } from '../commands/frameworks.js'
import { browse } from '../commands/browse.js'
import { status } from '../commands/status.js'

export const TOOL_DEFINITIONS = [
  {
    name: 'apple_docs_search',
    description: 'Search Apple Developer Documentation with typo tolerance and tiered ranking. Supports exact, prefix, substring, fuzzy, and full-body matching. Results include matchQuality field.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (symbol name, API term, or natural language)' },
        framework: { type: 'string', description: 'Filter by framework slug (e.g. swiftui, foundation, design)' },
        kind: { type: 'string', description: 'Filter by role (e.g. symbol, article, collection)' },
        limit: { type: 'number', description: 'Max results (default 100)' },
        fuzzy: { type: 'boolean', description: 'Enable typo-tolerant fuzzy matching (default true)' },
        noDeep: { type: 'boolean', description: 'Disable background full-body search (default false)' },
        noEager: { type: 'boolean', description: 'Wait for full-body search to complete instead of returning early (default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'apple_docs_lookup',
    description: 'Look up a specific Apple documentation page by path or symbol name. Returns full Markdown content with metadata including declarations, parameters, platforms, and relationships.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Canonical page path (e.g. swiftui/view, design/human-interface-guidelines/accessibility)' },
        symbol: { type: 'string', description: 'Symbol name to look up (e.g. View, Publisher, NavigationStack)' },
        framework: { type: 'string', description: 'Disambiguate symbol by framework slug when multiple frameworks define the same name' },
      },
    },
  },
  {
    name: 'apple_docs_list_frameworks',
    description: 'List all known Apple documentation roots including frameworks, technologies, HIG, and tooling. Shows name, kind, page count, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Filter by kind: framework, technology, tooling, release-notes, tutorial' },
      },
    },
  },
  {
    name: 'apple_docs_browse',
    description: 'Browse the documentation topic tree for a framework. Lists all pages or drills into a specific page to show its children and references.',
    inputSchema: {
      type: 'object',
      properties: {
        framework: { type: 'string', description: 'Framework slug (e.g. swiftui, combine, design)' },
        path: { type: 'string', description: 'Page path to show children of (e.g. swiftui/view, design/human-interface-guidelines/components)' },
        limit: { type: 'number', description: 'Max pages to return when listing a full framework (default: all)' },
      },
      required: ['framework'],
    },
  },
  {
    name: 'apple_docs_status',
    description: 'Show corpus statistics: total pages, frameworks by kind, disk usage, crawl progress, and last sync time.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

/**
 * Dispatch a tool call to the appropriate command function.
 */
export async function dispatchTool(name, args, ctx) {
  switch (name) {
    case 'apple_docs_search':
      return await search(args, ctx)
    case 'apple_docs_lookup':
      return await lookup(args, ctx)
    case 'apple_docs_list_frameworks':
      return await frameworks(args, ctx)
    case 'apple_docs_browse':
      return await browse(args, ctx)
    case 'apple_docs_status':
      return await status(args, ctx)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

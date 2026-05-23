// MCP tool surface for asset rendering: search_sf_symbols, list_apple_fonts,
// render_sf_symbol, render_font_text. Render outputs are deterministic for
// the same args; results are cached at the DB / disk layer (sf_symbol_renders)
// rather than the per-tool cache.

import { z } from 'zod'
import {
  listAppleFonts,
  renderFontText,
  renderSfSymbol,
  searchSfSymbols,
  SYMBOL_SCALES,
  SYMBOL_WEIGHTS,
} from '../../resources/apple-assets.js'
import { createMcpTextResult } from '../pagination.js'
import {
  listAppleFontsOutputSchema,
  renderFontTextOutputSchema,
  renderSfSymbolOutputSchema,
  searchSfSymbolsOutputSchema,
} from '../../output/schemas.js'
import {
  projectListAppleFonts,
  projectRenderFontText,
  projectRenderSfSymbol,
  projectSearchSfSymbols,
} from '../../output/projection.js'

const READ_ONLY_HINTS = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
}

export function registerAssetTools(server, ctx, cache) {
  server.registerTool(
    'search_sf_symbols',
    {
      description: 'Search indexed SF Symbols by name, category, alias, or keyword. Run `apple-docs setup` or `apple-docs sync` first if no symbols are indexed.',
      annotations: READ_ONLY_HINTS,
      outputSchema: searchSfSymbolsOutputSchema,
      inputSchema: {
        query: z.string().optional().describe('Symbol name or keyword. Empty returns ordered symbols.'),
        scope: z.enum(['public', 'private']).optional().describe('Restrict to public or private symbols.'),
        limit: z.coerce.number().int().min(1).max(500).optional().describe('Max results (default 100).'),
      },
    },
    cache.wrap('search_sf_symbols', async (args) => {
      return createMcpTextResult(projectSearchSfSymbols(searchSfSymbols(args.query ?? '', args, ctx)))
    }),
  )

  server.registerTool(
    'list_apple_fonts',
    {
      description: 'List indexed Apple font families and font files, including download-ready file identifiers. Run `apple-docs setup` or `apple-docs sync` first if no fonts are indexed.',
      annotations: READ_ONLY_HINTS,
      outputSchema: listAppleFontsOutputSchema,
      inputSchema: {},
    },
    cache.wrap('list_apple_fonts', async () => {
      return createMcpTextResult(projectListAppleFonts(listAppleFonts(ctx)))
    }),
  )

  server.registerTool(
    'render_sf_symbol',
    {
      description: 'Render an indexed SF Symbol to SVG or PNG. SVG content is inlined; PNG bytes are available via the returned resource URI.',
      annotations: READ_ONLY_HINTS,
      outputSchema: renderSfSymbolOutputSchema,
      inputSchema: {
        name: z.string().describe('SF Symbol name (e.g. pencil.and.sparkles).'),
        scope: z.enum(['public', 'private']).optional().describe('Symbol scope (default public).'),
        format: z.enum(['svg', 'png']).optional().describe('Output format (default png).'),
        size: z.coerce.number().int().min(8).max(1024).optional().describe('Square output size in points/pixels.'),
        color: z.string().optional().describe('Foreground hex (e.g. #000000). SVG also accepts "currentColor".'),
        background: z.string().optional().describe('Background hex (e.g. #ffffff), "transparent", or empty for none.'),
        weight: z.enum(SYMBOL_WEIGHTS).optional().describe('Public symbol weight variant (ignored for private).'),
        scale: z.enum(SYMBOL_SCALES).optional().describe('Public symbol scale variant (ignored for private).'),
      },
    },
    async (args) => {
      const render = await renderSfSymbol(args, ctx)
      const payload = {
        ...render,
        resourceUri: `apple-docs://sf-symbol/${render.scope}/${encodeURIComponent(render.name)}.${render.format}`,
      }
      if (render.format === 'svg') {
        payload.svg = await Bun.file(render.file_path).text()
      }
      return createMcpTextResult(projectRenderSfSymbol(payload))
    },
  )

  server.registerTool(
    'render_font_text',
    {
      description: 'Render a text preview using an indexed Apple font file. Returns SVG markup.',
      annotations: READ_ONLY_HINTS,
      outputSchema: renderFontTextOutputSchema,
      inputSchema: {
        fontId: z.string().describe('Font file id from list_apple_fonts.'),
        text: z.string().optional().describe('Text to render.'),
        size: z.coerce.number().int().min(8).max(512).optional().describe('Point size.'),
      },
    },
    async (args) => {
      const render = await renderFontText(args, ctx)
      return createMcpTextResult(projectRenderFontText(render))
    },
  )
}

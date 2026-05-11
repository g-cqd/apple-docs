// MCP tool surface for asset rendering: search_sf_symbols, list_apple_fonts,
// render_sf_symbol, render_font_text. None of these go through the cache
// wrap on the render path — Swift spawns are cached at the DB / disk
// layer (sf_symbol_renders) instead.

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
} from '../output-schemas.js'

// D.1: asset tools are read-only and idempotent. Render tools have a
// disk side-effect (sf_symbol_renders cache) but produce deterministic
// output for the same args, so idempotentHint stays true. None reach
// out to a network beyond the local DB / spawned helper binaries, so
// openWorldHint is false.
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
      description: 'Search indexed public and private SF Symbols by symbol name, category, alias, or keyword. Run `apple-docs setup` or `apple-docs sync` first if no symbols are indexed.',
      annotations: READ_ONLY_HINTS,
      outputSchema: searchSfSymbolsOutputSchema,
      inputSchema: {
        query: z.string().optional().describe('Symbol name or keyword query. Empty returns ordered symbols.'),
        scope: z.enum(['public', 'private']).optional().describe('Limit search to public or private symbols.'),
        limit: z.coerce.number().int().min(1).max(500).optional().describe('Max results (default 100).'),
      },
    },
    cache.wrap('search_sf_symbols', async (args) => {
      return createMcpTextResult(searchSfSymbols(args.query ?? '', args, ctx))
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
      // Wrap the bare array into a `families` envelope so structuredContent
      // is an object — the MCP outputSchema validator only accepts objects.
      return createMcpTextResult({ families: listAppleFonts(ctx) })
    }),
  )

  server.registerTool(
    'render_sf_symbol',
    {
      description: 'Render an indexed SF Symbol to SVG or PNG and return the generated asset metadata. SVG is text; PNG bytes are available from the returned file path or resource URI.',
      annotations: READ_ONLY_HINTS,
      outputSchema: renderSfSymbolOutputSchema,
      inputSchema: {
        name: z.string().describe('SF Symbol name, e.g. pencil.and.sparkles'),
        scope: z.enum(['public', 'private']).optional().describe('Symbol scope (default public).'),
        format: z.enum(['svg', 'png']).optional().describe('Output format (default png).'),
        size: z.coerce.number().int().min(8).max(1024).optional().describe('Square output size in points/pixels depending on format.'),
        color: z.string().optional().describe('Foreground hex color such as #000000. SVG also accepts the literal "currentColor" so the rendered path inherits the host page CSS color.'),
        background: z.string().optional().describe('Background hex color such as #ffffff, or "transparent"/empty for no background fill. Default: transparent.'),
        weight: z.enum(SYMBOL_WEIGHTS).optional().describe('Public symbol weight variant. Private symbols ignore weight.'),
        scale: z.enum(SYMBOL_SCALES).optional().describe('Public symbol scale variant. Private symbols ignore scale.'),
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
      return createMcpTextResult(payload)
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
      return createMcpTextResult(await renderFontText(args, ctx))
    },
  )
}

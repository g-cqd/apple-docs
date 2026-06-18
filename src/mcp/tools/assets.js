// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
// MCP tool surface for asset rendering: search_sf_symbols, list_apple_fonts,
// render_sf_symbol, render_font_text. Render outputs are deterministic for
// the same args; results are cached at the DB / disk layer (sf_symbol_renders)
// rather than the per-tool cache.

import { z } from 'zod'
import { projectListAppleFonts, projectRenderFontText, projectRenderSfSymbol, projectSearchSfSymbols } from '../../output/projection.js'
import { listAppleFonts, renderFontText, renderSfSymbol, SYMBOL_SCALES, SYMBOL_WEIGHTS, searchSfSymbols } from '../../resources/apple-assets.js'
import { createMcpTextResult } from '../pagination.js'

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
      description: 'Search SF Symbols by name, category, alias, or keyword.',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        query: z.string().optional().describe('Name or keyword; empty lists all.'),
        scope: z.enum(['public', 'private']).optional(),
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
      description: 'List Apple font families and files (ids feed render_font_text).',
      annotations: READ_ONLY_HINTS,
      inputSchema: {},
    },
    cache.wrap('list_apple_fonts', async () => {
      return createMcpTextResult(projectListAppleFonts(listAppleFonts(ctx)))
    }),
  )

  server.registerTool(
    'render_sf_symbol',
    {
      description: 'Render an SF Symbol to SVG (inlined) or PNG (fetch via returned resource URI).',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        name: z.string().describe('Symbol name, e.g. pencil.and.sparkles.'),
        scope: z.enum(['public', 'private']).optional().describe('Default public.'),
        format: z.enum(['svg', 'png']).optional().describe('Default png.'),
        size: z.coerce.number().int().min(8).max(1024).optional().describe('Square size in px.'),
        color: z.string().optional().describe('Foreground hex or "currentColor" (svg).'),
        background: z.string().optional().describe('Background hex or "transparent".'),
        weight: z.enum(SYMBOL_WEIGHTS).optional().describe('Public symbols only.'),
        scale: z.enum(SYMBOL_SCALES).optional().describe('Public symbols only.'),
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
      description: 'Render a text preview as SVG using an Apple font.',
      annotations: READ_ONLY_HINTS,
      inputSchema: {
        fontId: z.string().describe('Id from list_apple_fonts.'),
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

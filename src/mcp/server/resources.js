// MCP resource registrations: stable URIs that map to corpus content
// (apple-docs://doc/<key>, apple-docs://framework/<slug>,
// apple-docs://sf-symbol/<scope>/<name>.<format>, apple-docs://font/<id>).
// Pulled out of mcp/server.js as part of Phase B.

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { browse } from '../../commands/browse.js'
import { frameworks } from '../../commands/frameworks.js'
import { lookup } from '../../commands/lookup.js'
import { renderSfSymbol } from '../../resources/apple-assets.js'
import {
  paginateArrayField,
} from '../pagination.js'
import {
  projectBrowse,
  projectFrameworks,
  projectReadDoc,
} from '../projection.js'
import { parseResourcePagination, sanitizeDocumentPayload } from './helpers.js'

export function registerResources(server, ctx) {
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

  server.resource(
    'sf-symbol',
    new ResourceTemplate('apple-docs://sf-symbol/{scope}/{name}.{format}', { list: undefined }),
    { description: 'Read or render an SF Symbol asset', mimeType: 'application/octet-stream' },
    async (uri, { scope, name, format }) => {
      const requestedFormat = String(format) === 'svg' ? 'svg' : 'png'
      const render = await renderSfSymbol({
        scope: String(scope),
        name: decodeURIComponent(String(name)),
        format: requestedFormat,
        size: uri.searchParams.get('size') ?? undefined,
        color: uri.searchParams.get('color') ?? uri.searchParams.get('fg') ?? undefined,
        background: uri.searchParams.get('background') ?? uri.searchParams.get('bg') ?? undefined,
        weight: uri.searchParams.get('weight') ?? undefined,
        scale: uri.searchParams.get('scale') ?? undefined,
      }, ctx)
      const file = Bun.file(render.file_path)
      const content = requestedFormat === 'svg'
        ? { text: await file.text(), mimeType: render.mime_type }
        : { blob: Buffer.from(await file.arrayBuffer()).toString('base64'), mimeType: render.mime_type }
      return {
        contents: [{
          uri: uri.href,
          ...content,
        }],
      }
    },
  )

  server.resource(
    'font',
    new ResourceTemplate('apple-docs://font/{id}', { list: undefined }),
    { description: 'Read an indexed Apple font file', mimeType: 'application/octet-stream' },
    async (uri, { id }) => {
      const font = ctx.db.getAppleFontFile(String(id))
      if (!font) throw new Error(`Font file not found: ${id}`)
      const file = Bun.file(font.file_path)
      if (!await file.exists()) throw new Error(`Font file missing on disk: ${font.file_path}`)
      return {
        contents: [{
          uri: uri.href,
          blob: Buffer.from(await file.arrayBuffer()).toString('base64'),
          mimeType: font.format === 'ttf' ? 'font/ttf' : font.format === 'otf' ? 'font/otf' : 'application/octet-stream',
        }],
      }
    },
  )
}

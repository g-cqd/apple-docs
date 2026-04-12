import { join } from 'node:path'
import { readText } from '../storage/files.js'

/**
 * Look up a specific documentation page by path or symbol name.
 * @param {{ path?: string, symbol?: string, framework?: string }} opts
 * @param {{ db, dataDir }} ctx
 */
export async function lookup(opts, ctx) {
  const { db, dataDir } = ctx
  let page = null

  if (opts.path) {
    page = db.getPage(opts.path)
  } else if (opts.symbol) {
    page = db.searchByTitle(opts.symbol, opts.framework ?? null)
  }

  if (!page) {
    return { found: false, path: opts.path ?? opts.symbol }
  }

  // Read markdown content
  const mdPath = join(dataDir, 'markdown', page.path + '.md')
  const content = await readText(mdPath)

  return {
    found: true,
    metadata: {
      title: page.title,
      framework: page.framework,
      rootSlug: page.root_slug,
      role: page.role,
      roleHeading: page.role_heading,
      abstract: page.abstract,
      platforms: page.platforms ? JSON.parse(page.platforms) : [],
      declaration: page.declaration,
      path: page.path,
      downloadedAt: page.downloaded_at,
      convertedAt: page.converted_at,
    },
    content: content ?? null,
    note: content ? undefined : 'Markdown not yet generated. Run apple-docs sync first.',
  }
}

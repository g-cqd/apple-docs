import { join } from 'node:path'
import { readText, readJSON } from '../storage/files.js'
import { ensureNormalizedDocument } from '../content/hydrate.js'
import { normalize } from '../content/normalize.js'
import { renderMarkdown } from '../content/render-markdown.js'

/**
 * Look up a specific documentation page by path or symbol name.
 * @param {{ path?: string, symbol?: string, framework?: string }} opts
 * @param {{ db, dataDir }} ctx
 */
export async function lookup(opts, ctx) {
  const { db, dataDir } = ctx
  let page = null
  let sections = []

  if (opts.path) {
    page = db.getPage(opts.path)
  } else if (opts.symbol) {
    page = db.searchByTitle(opts.symbol, opts.framework ?? null)
  }

  if (!page) {
    return { found: false, path: opts.path ?? opts.symbol }
  }

  // Read markdown content — try persisted file first, then render on-demand from raw JSON
  const mdPath = join(dataDir, 'markdown', page.path + '.md')
  let content = await readText(mdPath)
  let fallback = false

  if (!content) {
    sections = db.getDocumentSections(page.path)
    if (sections.length === 0) {
      await ensureNormalizedDocument(db, dataDir, page.path, page.source_type ?? 'apple-docc')
      sections = db.getDocumentSections(page.path)
    }
    if (sections.length > 0) {
      content = renderMarkdown({ ...page, key: page.path }, sections)
      fallback = true
    }
  }

  if (!content) {
    const jsonPath = join(dataDir, 'raw-json', page.path + '.json')
    const json = await readJSON(jsonPath)
    if (json) {
      try {
        const normalized = normalize(json, page.path, page.source_type ?? 'apple-docc')
        sections = normalized.sections ?? sections
        content = renderMarkdown(normalized.document, normalized.sections)
        fallback = true
      } catch {
        // Render failed — content stays null
      }
    }
  }

  return {
    found: true,
    metadata: {
      title: page.title,
      framework: page.framework,
      rootSlug: page.root_slug,
      role: page.role,
      roleHeading: page.role_heading,
      abstract: page.abstract,
      platforms: page.platforms
        ? (typeof page.platforms === 'string' ? JSON.parse(page.platforms) : page.platforms)
        : [],
      declaration: page.declaration,
      path: page.path,
      downloadedAt: page.downloaded_at,
      convertedAt: page.converted_at,
    },
    content: content ?? null,
    sections,
    note: content
      ? (fallback ? 'Rendered on-demand from normalized content.' : undefined)
      : 'No content available. Run apple-docs sync first.',
  }
}

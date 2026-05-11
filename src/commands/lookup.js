import { readText, readJSON, writeText } from '../storage/files.js'
import { ensureNormalizedDocument } from '../content/hydrate.js'
import { normalize } from '../content/normalize.js'
import { renderMarkdown } from '../content/render-markdown.js'
import { keyPath } from '../lib/safe-path.js'
import { getProfile, getProfileConfig } from '../storage/profiles.js'

/**
 * Look up a specific documentation page by path or symbol name.
 * @param {{ path?: string, symbol?: string, framework?: string, noCache?: boolean, includeSections?: boolean }} opts
 * @param {{ db, dataDir }} ctx
 */
export async function lookup(opts, ctx) {
  const { db, dataDir } = ctx
  let page = null
  const includeSections = opts.includeSections === true || opts.section != null

  if (opts.path) {
    page = db.getPage(opts.path)
  } else if (opts.symbol) {
    page = db.searchByTitle(opts.symbol, opts.framework ?? null)
  }

  if (!page) {
    return { found: false, path: opts.path ?? opts.symbol }
  }

  // `getPage` aliases the documents.key column to `path` for legacy callers,
  // but `searchByTitle` returns the documents row verbatim with `key` as the
  // identifier. Normalize once so every path-construction below sees the
  // same value regardless of how the page was looked up.
  const pagePath = page.path ?? page.key

  // Short-circuit: if a previous lookup of this page rendered Markdown
  // successfully, reuse it. Different section/match/maxChars args produce
  // distinct tool-cache keys but all want the same rendered body — caching
  // here amortizes `renderMarkdown()` across those variants.
  const markdownCache = ctx.markdownCache
  const cached = markdownCache?.get(pagePath)
  let content = cached?.content ?? null
  let sections = cached?.sections ?? []
  let fallback = cached?.fallback ?? false

  // Read markdown content — try persisted file first, then render on-demand from raw JSON
  const mdPath = keyPath(dataDir, 'markdown', pagePath, '.md')
  if (!content) content = await readText(mdPath)

  // If section extraction is requested, always load sections from DB
  if (includeSections && content && sections.length === 0) {
    sections = db.getDocumentSections(pagePath)
  }

  if (!content) {
    sections = db.getDocumentSections(pagePath)
    if (sections.length === 0) {
      await ensureNormalizedDocument(db, dataDir, pagePath, page.source_type ?? 'apple-docc')
      sections = db.getDocumentSections(pagePath)
    }
    if (sections.length > 0) {
      content = renderMarkdown({ ...page, key: pagePath }, sections)
      fallback = true
    }
  }

  if (!content) {
    const jsonPath = keyPath(dataDir, 'raw-json', pagePath, '.json')
    const json = await readJSON(jsonPath)
    if (json) {
      try {
        const normalized = normalize(json, pagePath, page.source_type ?? 'apple-docc')
        sections = normalized.sections ?? sections
        content = renderMarkdown(normalized.document, normalized.sections)
        fallback = true
      } catch {
        // Render failed — content stays null
      }
    }
  }

  // Populate the markdown cache after any render path succeeds. Intentionally
  // skipped on cache-hit (nothing new to store) and when content is null
  // (negative results are handled at the tool-cache layer with CACHE_NEGATIVE).
  if (!cached && content && markdownCache) {
    markdownCache.set(pagePath, { content, sections, fallback })
  }

  // Cache on-demand rendered content if the active profile supports it
  if (fallback && content && !opts.noCache) {
    try {
      const profile = getProfile(db)
      const config = getProfileConfig(profile)
      if (config.cacheOnRead) {
        await writeText(mdPath, content)
      }
    } catch {
      // Caching is best-effort — don't fail the lookup
    }
  }

  const metadata = {
    title: page.title,
    framework: page.framework,
    rootSlug: page.root_slug,
    roleHeading: page.role_heading,
    abstract: page.abstract,
    platforms: page.platforms
      ? (typeof page.platforms === 'string' ? JSON.parse(page.platforms) : page.platforms)
      : [],
    declaration: page.declaration,
    path: pagePath,
    ...(page.is_deprecated ? { isDeprecated: true } : {}),
    ...(page.is_beta ? { isBeta: true } : {}),
  }

  // Section extraction: return a specific section by heading, sectionKind, or content match
  if (opts.section && sections.length > 0) {
    const sectionQuery = opts.section
    const match = sections.find(s =>
      s.heading === sectionQuery || s.heading?.endsWith(sectionQuery)
      || (s.sectionKind ?? s.section_kind) === sectionQuery,
    ) ?? sections.find(s =>
      (s.contentText ?? s.content_text)?.includes(sectionQuery),
    )
    if (match) {
      return { found: true, metadata, content: match.contentText ?? match.content_text ?? 'Section content not available.', sections: [match] }
    }
    const available = sections.map(s => s.heading ?? s.sectionKind ?? s.section_kind).filter(Boolean).join(', ')
    return { found: true, metadata, content: null, sections, note: `Section not found: ${sectionQuery}. Available sections: ${available}` }
  }

  // Legacy lite-tier snapshots dropped document_sections entirely; for
  // consumers still on one of those, surface a clear upgrade hint
  // instead of silently empty content. The current snapshot has only
  // one tier, so this branch only fires on stale installs.
  let note 
  let tierLimitation 
  if (content) {
    note = fallback ? 'Rendered on-demand from normalized content.' : undefined
  } else {
    const tier = db.getTier()
    if (tier === 'lite') {
      note = 'Content body unavailable on a legacy lite-tier snapshot. Metadata and declaration shown.'
      tierLimitation = {
        tier: 'lite',
        reason: 'The legacy lite snapshot includes metadata only — document sections and raw content were not included.',
        upgrade: "Run 'apple-docs setup --force' to install the current snapshot, which carries full document content.",
      }
    } else {
      note = 'No content available. Run apple-docs sync first.'
    }
  }

  return {
    found: true,
    metadata,
    content: content ?? null,
    sections: includeSections ? sections : [],
    note,
    tierLimitation,
  }
}

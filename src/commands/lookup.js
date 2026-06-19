import { normalizeIdentifier } from '../apple/normalizer.js'
import { ensureNormalizedDocument } from '../content/hydrate.js'
import { normalize } from '../content/normalize.js'
import { renderMarkdown } from '../content/render-markdown.js'
import { keyPath } from '../lib/safe-path.js'
import { readJSON, readText, writeText } from '../storage/files.js'
import { getProfile, getProfileConfig } from '../storage/profiles.js'

/**
 * @typedef {any} LookupArgs
 * @property {string} [path]                  Canonical page path (e.g. swiftui/view).
 * @property {string} [symbol]                Symbol name (e.g. View).
 * @property {string} [framework]             Disambiguate symbol when multiple frameworks share the name.
 * @property {string} [section]               Extract a specific section by heading or file path.
 * @property {boolean} [includeSections]      Return the full sections list (default: skeleton).
 * @property {boolean} [noCache]              Skip the markdown render-cache write on miss.
 *
 * @typedef {any} DocMetadata
 * @property {string} title
 * @property {string|null} framework
 * @property {string|null} rootSlug
 * @property {string|null} roleHeading
 * @property {string|null} kind
 * @property {string|null} abstract
 * @property {string|null} declaration
 * @property {string} path
 * @property {object|Array} [platforms]
 * @property {true} [isDeprecated]
 * @property {true} [isBeta]
 * @property {true} [isReleaseNotes]
 * @property {{ inheritsFrom?: number, inheritedBy?: number, conformsTo?: number, seeAlso?: number, children?: number }} [relationships]
 *
 * @typedef {any} LookupResult
 * @property {boolean} found
 * @property {DocMetadata} [metadata]
 * @property {string|null} [content]
 * @property {any[]} [sections]
 * @property {string} [note]
 *
 * Look up a specific documentation page by path or symbol name.
 *
 * @param {LookupArgs} opts
 * @param {any} ctx
 * @returns {Promise<LookupResult>}
 */
export async function lookup(opts, ctx) {
  const { db, dataDir } = ctx
  let page = null
  const includeSections = opts.includeSections === true || opts.section != null

  if (opts.path) {
    page = db.getPage(opts.path)
    if (!page) {
      // Accept the spellings people naturally paste — `documentation/...`
      // prefixes, `/documentation/...`, `doc://` URIs, mixed case — by
      // retrying with the canonical key form before giving up.
      const normalized = normalizeIdentifier(opts.path)
      if (normalized && normalized !== opts.path) page = db.getPage(normalized)
    }
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
    let json = await readJSON(jsonPath)
    if (!json) {
      // Compressed raw payload shipped in the DB (single snapshot) — used when
      // loose raw-json files aren't materialized on disk.
      const raw = db.getRawPayloadByKey?.(pagePath)
      if (raw) {
        try {
          json = JSON.parse(raw)
        } catch {
          /* not JSON — skip */
        }
      }
    }
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

  // Cheap COUNT-by-relation-type so callers know whether a follow-up
  // relationship walk is worthwhile. The counts themselves are emitted in
  // the public projection; an empty object is also emitted (consistent
  // shape, projection drops the key when empty).
  const relationshipCounts = db.getRelationshipCountsByType(pagePath)

  const metadata = {
    title: page.title,
    framework: page.framework,
    rootSlug: page.root_slug,
    roleHeading: page.role_heading,
    kind: page.kind ?? null,
    abstract: page.abstract,
    platforms: page.platforms ? (typeof page.platforms === 'string' ? JSON.parse(page.platforms) : page.platforms) : [],
    declaration: page.declaration,
    path: pagePath,
    ...(Object.keys(relationshipCounts).length > 0 ? { relationships: relationshipCounts } : {}),
    ...(page.is_deprecated ? { isDeprecated: true } : {}),
    ...(page.is_beta ? { isBeta: true } : {}),
  }

  // Section extraction: return a specific section by heading, sectionKind, or content match
  if (opts.section && sections.length > 0) {
    const sectionQuery = opts.section
    const match =
      sections.find(
        (/** @type {any} */ s) => s.heading === sectionQuery || s.heading?.endsWith(sectionQuery) || (s.sectionKind ?? s.section_kind) === sectionQuery,
      ) ?? sections.find((/** @type {any} */ s) => (s.contentText ?? s.content_text)?.includes(sectionQuery))
    if (match) {
      return { found: true, metadata, content: match.contentText ?? match.content_text ?? 'Section content not available.', sections: [match] }
    }
    const available = sections
      .map((/** @type {any} */ s) => s.heading ?? s.sectionKind ?? s.section_kind)
      .filter(Boolean)
      .join(', ')
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

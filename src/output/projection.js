/**
 * Single public-output boundary for every surface the project exposes —
 * MCP tools, MCP resources, CLI `--json` mode, web `/api/*` routes.
 *
 * Each project*() function applies a strict allowlist to its rich
 * command-envelope input and returns the public shape that other
 * surfaces are allowed to see. Internal/infrastructural fields
 * (search-cascade tiers, DB column names, disk paths, reader-pool
 * stats, deadline reasons, pagination strategies) are dropped before
 * serialisation.
 *
 * `APPLE_DOCS_DEBUG=1` in the environment short-circuits every
 * allowlist and returns the raw envelope unchanged. Use for local
 * debugging only — the public deployment runs without it.
 *
 * Per-call override: `{ debug: true }` on opts forces passthrough on
 * that single call (used by leak-guard tests).
 */

import { publicConfidence } from './confidence.js'
import { safeWebDocKey } from '../lib/safe-path.js'
import { DEBUG_PASSTHROUGH as CONFIG_DEBUG } from '../config.js'

export const DEBUG_PASSTHROUGH = CONFIG_DEBUG

function bypass(opts) {
  if (opts?.debug === true) return true
  return DEBUG_PASSTHROUGH
}

// Helper: copy a fixed set of keys from src → dst if defined.
function pick(src, keys) {
  const out = {}
  for (const k of keys) if (src?.[k] !== undefined) out[k] = src[k]
  return out
}

// True-only flag — emit the property only when truthy. Keeps payloads
// quiet by default and conveys the binary nature in a single `?: true`.
function flagIf(out, src, key) {
  if (src?.[key]) out[key] = true
}

// --- pageInfo ----------------------------------------------------------------

// The rich envelope's pageInfo carries `strategy`, `totalSections`,
// `pageSections`, `maxChars` and other paginator-internals. The public
// shape keeps only the navigational fields the caller actually needs.
const PAGE_INFO_KEEP = [
  'page', 'totalPages',
  'hasNextPage', 'hasPreviousPage',
  'totalItems',
]

function projectPageInfo(pageInfo) {
  if (!pageInfo || typeof pageInfo !== 'object') return undefined
  const out = pick(pageInfo, PAGE_INFO_KEEP)
  return Object.keys(out).length > 0 ? out : undefined
}

// --- search_docs -------------------------------------------------------------

const SEARCH_HIT_KEEP = [
  'path', 'title',
  'framework', 'rootSlug',
  'kind', 'sourceType',
  'abstract', 'declaration',
  'platforms',
  'language',
  'snippet', 'relatedCount',
]

// `webPaths: true` (web /api/search only) adds a `webPath` field when the
// site URL for a hit differs from its corpus key — a handful of overlong
// Swift init keys whose web path carries a hashed segment. MCP and CLI
// surfaces never pass the option: their `path` stays the raw corpus key
// that read_doc accepts, and no webPath is emitted there.
export function projectSearchHit(hit, opts) {
  if (!hit || typeof hit !== 'object') return hit
  const out = pick(hit, SEARCH_HIT_KEEP)
  out.confidence = publicConfidence(hit.matchQuality)
  if (opts?.webPaths === true && typeof hit.path === 'string') {
    const webPath = safeWebDocKey(hit.path)
    if (webPath !== hit.path) out.webPath = webPath
  }
  flagIf(out, hit, 'isDeprecated')
  flagIf(out, hit, 'isBeta')
  flagIf(out, hit, 'isReleaseNotes')
  return out
}

export function projectSearchResult(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result

  // `search_docs read=true` returns a doc-shaped payload instead of a
  // results envelope. Dispatch on `found`/`content` so the same MCP tool
  // gets the right projection for either variant.
  if (result.found !== undefined && Array.isArray(result.results) === false) {
    return projectReadDoc(result, opts)
  }

  const out = {
    query: typeof result.query === 'string' ? result.query : '',
    total: typeof result.total === 'number' ? result.total : 0,
    ...(typeof result.hasMore === 'boolean' ? { hasMore: result.hasMore } : {}),
    results: Array.isArray(result.results) ? result.results.map(hit => projectSearchHit(hit, opts)) : [],
  }

  if (out.results.some(r => r.confidence === 'approximate')) out.approximate = true
  if (result.partial) out.truncated = true

  const pi = projectPageInfo(result.pageInfo)
  if (pi) out.pageInfo = pi
  return out
}

// --- read_doc ----------------------------------------------------------------

const METADATA_KEEP = [
  'title', 'framework', 'rootSlug', 'roleHeading', 'kind',
  'abstract', 'declaration', 'path', 'platforms',
  'relationships',
]

function projectMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return metadata
  const out = pick(metadata, METADATA_KEEP)
  flagIf(out, metadata, 'isDeprecated')
  flagIf(out, metadata, 'isBeta')
  flagIf(out, metadata, 'isReleaseNotes')
  return out
}

function sectionSkeleton(section) {
  if (!section || typeof section !== 'object') return section
  if (section.heading !== undefined && typeof section.chars === 'number') {
    return { heading: section.heading, chars: section.chars }
  }
  const heading = section.heading ?? null
  const text = section.contentText ?? section.content_text ?? ''
  return { heading, chars: typeof text === 'string' ? text.length : 0 }
}

function projectSectionFull(section) {
  if (!section || typeof section !== 'object') return section
  const out = {}
  if (section.heading !== undefined) out.heading = section.heading
  const text = section.contentText ?? section.content_text
  if (text !== undefined) out.contentText = text
  return out
}

export function projectReadDoc(payload, opts) {
  if (bypass(opts)) return payload
  if (!payload || typeof payload !== 'object') return payload

  if (payload.found === false) {
    return payload.note ? { found: false, note: payload.note } : { found: false }
  }

  const full = opts?.full === true
  const out = { found: true }
  if (payload.metadata) out.metadata = projectMetadata(payload.metadata)
  if (payload.content !== undefined) out.content = payload.content
  if (Array.isArray(payload.sections)) {
    out.sections = payload.sections.map(full ? projectSectionFull : sectionSkeleton)
  }
  if (payload.matches !== undefined) out.matches = payload.matches
  if (payload.note !== undefined) out.note = payload.note
  if (payload.bestMatch) out.bestMatch = projectSearchHit(payload.bestMatch)

  const pi = projectPageInfo(payload.pageInfo)
  if (pi) out.pageInfo = pi
  return out
}

// --- list_frameworks ---------------------------------------------------------

const ROOT_KEEP = ['slug', 'name', 'kind', 'pageCount']

export function projectFrameworks(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result

  const out = {
    total: typeof result.total === 'number' ? result.total : 0,
    roots: Array.isArray(result.roots)
      ? result.roots.map(root => pick(root, ROOT_KEEP))
      : [],
  }
  const pi = projectPageInfo(result.pageInfo)
  if (pi) out.pageInfo = pi
  return out
}

// --- browse ------------------------------------------------------------------

const BROWSE_PAGE_KEEP = ['path', 'title', 'kind', 'abstract']
const BROWSE_CHILD_KEEP = ['path', 'title', 'kind', 'section']

export function projectBrowse(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result

  const out = {}
  if (result.framework !== undefined) out.framework = result.framework
  if (result.title !== undefined) out.title = result.title
  if (result.path !== undefined) out.path = result.path
  if (typeof result.year === 'number') out.year = result.year

  if (Array.isArray(result.groups)) {
    out.groups = result.groups.map(g => ({ year: g.year, count: g.count }))
    if (typeof result.total === 'number') out.total = result.total
  }
  if (Array.isArray(result.pages)) {
    out.pages = result.pages.map(p => pick(p, BROWSE_PAGE_KEEP))
    if (typeof result.total === 'number') out.total = result.total
  }
  if (Array.isArray(result.children)) {
    out.children = result.children.map(c => pick(c, BROWSE_CHILD_KEEP))
  }

  const pi = projectPageInfo(result.pageInfo)
  if (pi) out.pageInfo = pi
  return out
}

// --- list_taxonomy -----------------------------------------------------------

const TAXONOMY_FIELDS = ['kind', 'role', 'docKind', 'roleHeading', 'sourceType']

function projectTaxonomyEntries(arr) {
  return Array.isArray(arr)
    ? arr.map(v => ({ value: v.value ?? null, count: v.count ?? 0 }))
    : []
}

export function projectTaxonomy(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result

  // The command supports two return shapes: targeted (`{ field, values }`)
  // and broad (`{ kind, role, docKind, roleHeading, sourceType }`).
  // Project to a uniform broad shape — single-field callers see the one
  // field they asked for; others see all fields.
  if (result.field && Array.isArray(result.values)) {
    return { [result.field]: projectTaxonomyEntries(result.values) }
  }
  const out = {}
  for (const f of TAXONOMY_FIELDS) {
    if (Array.isArray(result[f])) out[f] = projectTaxonomyEntries(result[f])
  }
  return out
}

// --- asset tools -------------------------------------------------------------

const SF_SYMBOL_HIT_KEEP = ['name', 'scope']

export function projectSearchSfSymbols(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result
  const results = Array.isArray(result.results) ? result.results : []
  return { results: results.map(s => pick(s, SF_SYMBOL_HIT_KEEP)) }
}

export function projectListAppleFonts(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result
  const families = Array.isArray(result.families) ? result.families : []
  return {
    families: families.map(f => ({
      id: f.id,
      ...(f.name !== undefined ? { name: f.name } : {}),
      files: Array.isArray(f.files)
        ? f.files.map(file => ({ id: file.id, file_name: file.file_name }))
        : [],
    })),
  }
}

export function projectRenderSfSymbol(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result
  const out = {
    name: result.name,
    scope: result.scope,
    format: result.format,
  }
  if (result.resourceUri !== undefined) out.resourceUri = result.resourceUri
  if (result.svg !== undefined) out.svg = result.svg
  // file_path intentionally dropped — internal disk path.
  return out
}

export function projectRenderFontText(result, opts) {
  if (bypass(opts)) return result
  if (!result || typeof result !== 'object') return result
  const out = {}
  if (result.text !== undefined) out.text = result.text
  if (result.mimeType !== undefined) out.mimeType = result.mimeType
  if (result.content !== undefined) out.content = result.content
  // `format` and `font` intentionally dropped — internal rendering state.
  return out
}

// --- status ------------------------------------------------------------------

const STATUS_KEEP_USER = [
  'dataDir',
  'databaseSize',
  'rawJson', 'markdown',
  'lastSync', 'lastAction',
]

export function projectStatus(result, opts) {
  if (bypass(opts)) return result
  // `--advanced` callers receive the full envelope so the user can
  // inspect tier / capabilities / reader-pool internals deliberately.
  if (opts?.advanced === true) return result
  if (!result || typeof result !== 'object') return result

  const out = pick(result, STATUS_KEEP_USER)

  if (result.pages) {
    out.pages = {
      active: result.pages.active ?? 0,
      deleted: result.pages.deleted ?? 0,
    }
  }
  if (result.roots) {
    out.roots = {
      total: result.roots.total ?? 0,
      byKind: result.roots.byKind ?? {},
    }
  }
  if (result.activity) {
    out.activity = {
      action: result.activity.action,
      status: result.activity.status,
      startedAt: result.activity.startedAt ?? null,
    }
  }
  if (result.updateAvailable?.available) {
    out.updateAvailable = {
      current: result.updateAvailable.current,
      latest: result.updateAvailable.latest,
    }
  }
  if (result.freshness?.lastSyncAt) {
    out.freshness = {
      lastSyncAt: result.freshness.lastSyncAt,
      daysSinceSync: result.freshness.daysSinceSync,
      isStale: !!result.freshness.isStale,
    }
  }
  // `tier`, `capabilities.searchTrigram`, `capabilities.searchBody`,
  // `activity.pid` / `.alive`, `crawlProgress`, `crawlByRoot` are
  // intentionally dropped (snapshot-tier name, index-table availability,
  // crawler-state internals).
  return out
}

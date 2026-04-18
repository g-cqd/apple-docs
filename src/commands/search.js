import { fuzzyMatchTitles } from '../lib/fuzzy.js'
import { renderSnippet } from '../content/render-snippet.js'
import { detectIntent } from '../search/intent.js'
import { rerank } from '../search/ranking.js'
import { tokenize, pruneStopwords, pickHighSignalToken } from '../search/relaxation.js'

const TIER_LABELS = ['exact', 'prefix', 'contains', 'match']
const ROLE_KIND_FILTERS = new Set(['symbol', 'article', 'collection', 'overview', 'tutorial', 'samplecode', 'sample_code', 'sample-project', 'sampleproject'])

/**
 * Search with tiered cascade: fast title/path tiers first, deep body search only
 * when needed.
 *
 * Tiers 1 (FTS5) and 2 (trigram) run in parallel. Tier 3 (fuzzy) runs
 * sequentially only when fast tiers produce very few results. Tier 4 (body)
 * runs only when the requested result window is not already satisfied, or when
 * explicitly forced with `noEager`.
 *
 * @param {{ query: string, framework?: string, kind?: string, limit?: number,
 *           offset?: number, fuzzy?: boolean, noDeep?: boolean, noEager?: boolean,
 *           source?: string, language?: string, platform?: string,
 *           minIos?: string, minMacos?: string, minWatchos?: string,
 *           minTvos?: string, minVisionos?: string }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function search(opts, ctx) {
  const { query, kind } = opts
  const limit = Math.max(Number.parseInt(opts.limit) || 100, 1)
  const offset = Math.max(Number.parseInt(opts.offset) || 0, 0)
  const requestedWindow = limit + offset
  const sourceTypes = normalizeSourceFilter(opts.source)

  // Resolve framework slug (allows fuzzy input like "guidelines" → "app-store-review")
  let framework = opts.framework
  if (framework) {
    const root = ctx.db.resolveRoot(framework)
    framework = root?.slug ?? opts.framework
  }
  const fuzzy = opts.fuzzy !== false
  const noDeep = !!opts.noDeep
  const noEager = !!opts.noEager

  // Language and platform version filters
  const language = opts.language ?? null
  const minIos = opts.minIos ?? opts['min-ios'] ?? null
  const minMacos = opts.minMacos ?? opts['min-macos'] ?? null
  const minWatchos = opts.minWatchos ?? opts['min-watchos'] ?? null
  const minTvos = opts.minTvos ?? opts['min-tvos'] ?? null
  const minVisionos = opts.minVisionos ?? opts['min-visionos'] ?? null

  // --platform shorthand: ensure the platform column is non-null (available on that platform)
  const platform = opts.platform ?? null
  const platformFilters = buildPlatformFilters(platform, { minIos, minMacos, minWatchos, minTvos, minVisionos })
  const deprecated = normalizeDeprecatedFilter(opts.deprecated)
  const hasJsPostFilters = sourceTypes?.size > 1
    || !!kind
    || !!opts.year
    || !!opts.track
    || Object.values(platformFilters).some(Boolean)
    || deprecated !== 'include'
  const searchLimit = hasJsPostFilters ? Math.min(Math.max(requestedWindow * 10, 200), 1000) : requestedWindow

  if (!query?.trim()) return { results: [], total: 0, query: '' }

  const q = query.trim()
  const ftsQuery = buildFtsQuery(q)

  // Framework synonym expansion
  const frameworks = [framework]
  if (framework) {
    const synonyms = ctx.db.getFrameworkSynonyms(framework)
    for (const s of synonyms) {
      if (!frameworks.includes(s)) frameworks.push(s)
    }
  }

  // Push single source_type to SQL for efficient filtering; multi-source stays as JS post-filter
  const sqlSourceType = sourceTypes?.size === 1 ? [...sourceTypes][0] : null
  const filterOpts = { limit: searchLimit, language, sourceType: sqlSourceType }
  const activeFilters = { frameworks, sourceTypes, kind, language, platformFilters, year: opts.year, track: opts.track, deprecated }

  const results = []
  const seen = new Set()

  const addResults = (rows, quality) => {
    for (const r of rows) {
      if (!matchesSearchFilters(r, activeFilters)) continue
      if (seen.has(r.path)) continue
      seen.add(r.path)
      results.push({ ...formatResult(r), matchQuality: quality })
    }
  }

  // --- Fast phase: run T1 (FTS5) and T2 (trigram) concurrently ---

  // Tier 1: FTS5 tiered search
  const runFts = () => {
    const ftsResults = []
    try {
      for (const fw of frameworks) {
        ftsResults.push(...ctx.db.searchPages(ftsQuery, q, { ...filterOpts, framework: fw }))
      }
    } catch {
      // FTS5 query syntax error — try simpler query
      try {
        const simple = `"${q.replace(/"/g, '')}"*`
        for (const fw of frameworks) {
          ftsResults.push(...ctx.db.searchPages(simple, q, { ...filterOpts, framework: fw }))
        }
      } catch {}
    }
    return ftsResults
  }

  // Tier 2: Trigram substring (only if query >= 3 chars)
  const runTrigram = () => {
    if (q.length < 3) return []
    const triResults = []
    try {
      for (const fw of frameworks) {
        triResults.push(...ctx.db.searchTrigram(q, { ...filterOpts, framework: fw }))
      }
    } catch {}
    return triResults
  }

  // Tier 4: Body search
  const hasBody = !noDeep && ctx.db.getBodyIndexCount() > 0
  const runBody = () => {
    if (!hasBody) return []
    try {
      const bodyResults = []
      for (const fw of frameworks) {
        bodyResults.push(...ctx.db.searchBody(ftsQuery, { ...filterOpts, framework: fw }))
      }
      return bodyResults
    } catch { return [] }
  }

  // Run the fast tiers first so the web/CLI search path can return promptly.
  const [ftsResults, triResults] = await Promise.all([
    Promise.resolve().then(runFts),
    Promise.resolve().then(runTrigram),
  ])

  // Merge T1 results with tier labels
  for (const r of ftsResults) {
    if (!matchesSearchFilters(r, activeFilters)) continue
    if (seen.has(r.path)) continue
    seen.add(r.path)
    results.push({ ...formatResult(r), matchQuality: TIER_LABELS[r.tier] ?? 'match' })
  }

  // Merge T2 results (skipping already-seen from T1)
  addResults(triResults, 'substring')

  // Tier 3: Levenshtein fuzzy (only if T1+T2 combined < 5 and query >= 4 chars)
  if (results.length < 5 && q.length >= 4 && fuzzy) {
    const fuzzyMatches = fuzzyMatchTitles(q, ctx.db, { framework, kind, limit: searchLimit })
    for (const fm of fuzzyMatches) {
      const record = ctx.db.getSearchRecordById(fm.id)
      if (!record) continue
      if (!matchesSearchFilters(record, activeFilters)) continue
      if (seen.has(record.path)) continue
      seen.add(record.path)
      results.push({ ...formatResult(record), matchQuality: 'fuzzy', distance: fm.distance })
    }
  }

  // Body search: merge results or discard if we already have enough
  if (hasBody) {
    if (results.length < requestedWindow || noEager) {
      const bodyResults = await Promise.resolve().then(runBody)
      addResults(bodyResults, 'body')
    }
  }

  // Progressive relaxation: only runs when the strict cascade produced nothing
  // and the query is a multi-word natural-language phrase (no explicit quoted
  // phrase). Emits results tagged with a `relaxed*` matchQuality so downstream
  // surfaces can render a best-effort hint.
  let relaxationTier = null
  if (results.length === 0 && q.length >= 4 && !q.includes('"')) {
    const tokens = tokenize(q)
    if (tokens.length >= 3) {
      const pruned = pruneStopwords(tokens)

      // R1 — pruned AND: keep only high-signal tokens and re-run FTS5.
      if (pruned.length >= 1) {
        const prunedQuery = buildFtsQuery(pruned.join(' '))
        const r1 = []
        try {
          for (const fw of frameworks) {
            r1.push(...ctx.db.searchPages(prunedQuery, q, { ...filterOpts, framework: fw }))
          }
        } catch {}
        const before = results.length
        addResults(r1, 'relaxed')
        if (results.length > before) relaxationTier = 'pruned'
      }

      // R2 — pruned OR: join the pruned tokens with OR so any single hit wins.
      if (results.length === 0 && pruned.length >= 2) {
        const orQuery = pruned.map(t => `"${t.toLowerCase().replace(/"/g, '')}"`).join(' OR ')
        const r2 = []
        try {
          for (const fw of frameworks) {
            r2.push(...ctx.db.searchPages(orQuery, q, { ...filterOpts, framework: fw }))
          }
        } catch {}
        const before = results.length
        addResults(r2, 'relaxed-or')
        if (results.length > before) relaxationTier = 'pruned-or'
      }

      // R3 — trigram on a single high-signal token. Prefer a CamelCase token
      // so `NavigationStack` still drives the lookup when nothing else matched.
      if (results.length === 0) {
        const pool = pruned.length > 0 ? pruned : tokens
        const signal = pickHighSignalToken(pool)
        if (signal && signal.length >= 3) {
          const r3 = []
          try {
            for (const fw of frameworks) {
              r3.push(...ctx.db.searchTrigram(signal, { ...filterOpts, framework: fw }))
            }
          } catch {}
          const before = results.length
          addResults(r3, 'relaxed-token')
          if (results.length > before) relaxationTier = 'trigram'
        }
      }
    }
  }

  // Intent detection + source-aware reranking
  const intent = detectIntent(q)
  rerank(results, q, intent)

  const sliced = results.slice(offset, offset + limit)

  // Batch-fetch snippet data and related counts for final results
  try {
    const resultKeys = sliced.map(r => r.path)
    const snippetData = ctx.db.getDocumentSnippetData(resultKeys)
    const relatedCounts = ctx.db.getRelatedDocCounts(resultKeys)

    for (const r of sliced) {
      const data = snippetData.get(r.path)
      if (data) {
        r.snippet = renderSnippet(data.document, data.sections, q)
      }
      r.relatedCount = relatedCounts.get(r.path) ?? 0
    }
  } catch {
    // Snippet/related enrichment is non-critical
  }

  return {
    results: sliced,
    total: results.length,
    query,
    intent,
    ...(relaxationTier != null ? { relaxed: true, relaxationTier } : {}),
    tier: ctx.db.getTier(),
    trigramAvailable: ctx.db.hasTable('documents_trigram'),
    bodyIndexAvailable: hasBody,
  }
}

function formatResult(r) {
  return {
    title: r.title,
    framework: r.framework,
    rootSlug: r.root_slug,
    sourceType: r.source_type ?? null,
    sourceMetadata: r.source_metadata ?? null,
    kind: r.role_heading ?? r.role,
    abstract: r.abstract,
    path: r.path,
    platforms: r.platforms ? (typeof r.platforms === 'string' ? JSON.parse(r.platforms) : r.platforms) : [],
    declaration: r.declaration,
    urlDepth: r.url_depth ?? 0,
    isReleaseNotes: !!(r.is_release_notes),
    language: r.language ?? null,
    ...(r.is_deprecated ? { isDeprecated: true } : {}),
    ...(r.is_beta ? { isBeta: true } : {}),
  }
}

function normalizeSourceFilter(source) {
  if (!source) return null
  const values = Array.isArray(source) ? source : String(source).split(',')
  const normalized = values
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return normalized.length > 0 ? new Set(normalized) : null
}

function matchesSourceFilter(row, sourceTypes) {
  if (!sourceTypes) return true
  const sourceType = String(row?.source_type ?? row?.sourceType ?? '').toLowerCase()
  return sourceTypes.has(sourceType)
}

function matchesSearchFilters(row, filters) {
  return matchesSourceFilter(row, filters.sourceTypes)
    && matchesFrameworkFilter(row, filters.frameworks)
    && matchesKindFilter(row, filters.kind)
    && matchesLanguageFilter(row, filters.language)
    && matchesPlatformFilters(row, filters.platformFilters)
    && matchesMetadataFilters(row, filters.year, filters.track)
    && matchesDeprecatedFilter(row, filters.deprecated)
}

function normalizeDeprecatedFilter(value) {
  if (value == null || value === '') return 'include'
  const v = String(value).trim().toLowerCase()
  if (v === 'exclude' || v === 'only' || v === 'include') return v
  return 'include'
}

function matchesDeprecatedFilter(row, mode) {
  if (!mode || mode === 'include') return true
  const deprecated = !!(row?.is_deprecated ?? row?.isDeprecated)
  if (mode === 'exclude') return !deprecated
  if (mode === 'only') return deprecated
  return true
}

function matchesFrameworkFilter(row, frameworks) {
  const candidates = (frameworks ?? []).filter(Boolean).map(normalizeFilterValue)
  if (candidates.length === 0) return true

  const rowValues = [
    normalizeFilterValue(row?.root_slug ?? row?.rootSlug),
    normalizeFilterValue(row?.framework),
  ].filter(Boolean)

  return rowValues.some(value => candidates.includes(value))
}

function matchesKindFilter(row, kind) {
  if (!kind) return true
  const target = normalizeFilterValue(kind)
  if (!target) return true

  const displayedKind = normalizeFilterValue(row?.role_heading ?? row?.roleHeading)
  const looksLikeDisplayedKind = String(kind) !== String(kind).toLowerCase()
  if (looksLikeDisplayedKind) return displayedKind === target

  const roleCandidates = [
    row?.role,
    row?.doc_kind,
    row?.docKind,
    row?.kind,
  ].map(normalizeFilterValue).filter(Boolean)

  if (ROLE_KIND_FILTERS.has(target)) {
    return roleCandidates.includes(target)
  }

  return displayedKind === target
}

function matchesLanguageFilter(row, language) {
  if (!language) return true
  const normalizedLanguage = normalizeFilterValue(language)
  const value = normalizeFilterValue(row?.language)
  return !value || value === normalizedLanguage || value === 'both'
}

function matchesPlatformFilters(row, platformFilters) {
  const platforms = parsePlatforms(row?.platforms)
  return [
    ['minIos', 'ios', row?.min_ios ?? row?.minIos],
    ['minMacos', 'macos', row?.min_macos ?? row?.minMacos],
    ['minWatchos', 'watchos', row?.min_watchos ?? row?.minWatchos],
    ['minTvos', 'tvos', row?.min_tvos ?? row?.minTvos],
    ['minVisionos', 'visionos', row?.min_visionos ?? row?.minVisionos],
  ].every(([filterKey, platformKey, actual]) =>
    matchesPlatformVersion(actual ?? platforms?.[platformKey] ?? null, platformFilters[filterKey], {
      platformKey,
      platforms,
    }),
  )
}

function matchesPlatformVersion(actual, requested, opts = {}) {
  if (!requested) return true
  if (requested === '0') {
    if (actual) return true
    const explicitPlatforms = opts.platforms ? Object.keys(opts.platforms) : []
    if (explicitPlatforms.length === 0) return true
    return explicitPlatforms.includes(opts.platformKey)
  }
  if (!actual) return true
  return compareVersions(actual, requested) <= 0
}

function matchesMetadataFilters(row, year, track) {
  if (!year && !track) return true

  let metadata = null
  try {
    metadata = row?.source_metadata ?? row?.sourceMetadata
    metadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
  } catch {
    metadata = null
  }

  if (!metadata) return false
  if (year && metadata.year !== year) return false
  if (track) {
    const metadataTrack = normalizeFilterValue(metadata.track)
    if (!metadataTrack || !metadataTrack.includes(normalizeFilterValue(track))) return false
  }
  return true
}

function normalizeFilterValue(value) {
  return String(value ?? '').trim().toLowerCase()
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let i = 0; i < length; i++) {
    const leftPart = leftParts[i] ?? 0
    const rightPart = rightParts[i] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }

  return 0
}

function parseVersionParts(version) {
  return String(version ?? '')
    .match(/\d+/g)
    ?.map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite) ?? []
}

function parsePlatforms(platforms) {
  if (!platforms) return null
  if (typeof platforms === 'string') {
    try {
      return JSON.parse(platforms)
    } catch {
      return null
    }
  }
  return typeof platforms === 'object' ? platforms : null
}

/**
 * Map --platform shorthand to specific min_* filters.
 * If --platform ios is given without --min-ios, set minIos to '0' (meaning "available on iOS at all").
 */
function buildPlatformFilters(platform, explicit) {
  const filters = {
    minIos: explicit.minIos ?? null,
    minMacos: explicit.minMacos ?? null,
    minWatchos: explicit.minWatchos ?? null,
    minTvos: explicit.minTvos ?? null,
    minVisionos: explicit.minVisionos ?? null,
  }
  if (platform) {
    const key = {
      ios: 'minIos', macos: 'minMacos', watchos: 'minWatchos',
      tvos: 'minTvos', visionos: 'minVisionos',
    }[platform.toLowerCase()]
    if (key && !filters[key]) filters[key] = '0'
  }
  return filters
}

/**
 * Build FTS5 query with CamelCase expansion.
 */
function buildFtsQuery(q) {
  if (/\b(AND|OR|NOT)\b/.test(q) || q.includes('"')) return q

  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return '""'

  // CamelCase expansion: "NavigationStack" → also search "navigation" "stack"
  const expanded = []
  for (const term of terms) {
    expanded.push(term)
    const split = term.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
    if (split.length > 1) expanded.push(...split)
  }

  const unique = [...new Set(expanded.map(t => t.toLowerCase()))]

  if (unique.length === 1) {
    return `"${unique[0]}"*`
  }

  // All terms with prefix on last
  return `${unique.slice(0, -1).map(t => `"${t}"`).join(' ')} "${unique.at(-1)}"*`
}

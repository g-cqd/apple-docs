import { fuzzyMatchTitles } from '../lib/fuzzy.js'
import { renderSnippet } from '../content/render-snippet.js'
import { detectIntent } from '../search/intent.js'
import { rerank } from '../search/ranking.js'

const TIER_LABELS = ['exact', 'prefix', 'contains', 'match']

/**
 * Search with tiered cascade: FTS5 → trigram → fuzzy → body (background).
 *
 * @param {{ query: string, framework?: string, kind?: string, limit?: number,
 *           fuzzy?: boolean, noDeep?: boolean, noEager?: boolean,
 *           source?: string, language?: string, platform?: string,
 *           minIos?: string, minMacos?: string, minWatchos?: string,
 *           minTvos?: string, minVisionos?: string }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function search(opts, ctx) {
  const { query, kind } = opts
  const limit = Math.max(Number.parseInt(opts.limit) || 100, 1)
  const sourceTypes = normalizeSourceFilter(opts.source)
  const searchLimit = sourceTypes ? Math.max(limit * 10, 200) : limit

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
  const sqlSourceType = sourceTypes && sourceTypes.length === 1 ? sourceTypes[0] : null
  const filterOpts = { kind, limit: searchLimit, language, sourceType: sqlSourceType, ...platformFilters }

  // Start body search in background if index exists and not disabled
  let bodyPromise = null
  let bodyCancelled = false
  const hasBody = !noDeep && ctx.db.getBodyIndexCount() > 0
  if (hasBody) {
    bodyPromise = new Promise((resolve) => {
      // Give fast tiers a 200ms head start
      setTimeout(() => {
        if (bodyCancelled) return resolve([])
        try {
          const bodyResults = []
          for (const fw of frameworks) {
            bodyResults.push(...ctx.db.searchBody(ftsQuery, { ...filterOpts, framework: fw }))
          }
          resolve(bodyResults)
        } catch { resolve([]) }
      }, 200)
    })
  }

  const results = []
  const seen = new Set()

  const addResults = (rows, quality) => {
    for (const r of rows) {
      if (!matchesSourceFilter(r, sourceTypes)) continue
      if (seen.has(r.path)) continue
      seen.add(r.path)
      results.push({ ...formatResult(r), matchQuality: quality })
    }
  }

  // Tier 1: FTS5 tiered search (exact/prefix/contains/match via SQL CASE)
  try {
    for (const fw of frameworks) {
      const ftsResults = ctx.db.searchPages(ftsQuery, q, { ...filterOpts, framework: fw })
      for (const r of ftsResults) {
        if (!matchesSourceFilter(r, sourceTypes)) continue
        if (seen.has(r.path)) continue
        seen.add(r.path)
        results.push({ ...formatResult(r), matchQuality: TIER_LABELS[r.tier] ?? 'match' })
      }
    }
  } catch {
    // FTS5 query syntax error — try simpler query
    try {
      const simple = `"${q.replace(/"/g, '')}"*`
      for (const fw of frameworks) {
        const ftsResults = ctx.db.searchPages(simple, q, { ...filterOpts, framework: fw })
        addResults(ftsResults, 'match')
      }
    } catch {}
  }

  // Tier 2: Trigram substring (if < 5 results and query >= 3 chars)
  if (results.length < 5 && q.length >= 3) {
    try {
      for (const fw of frameworks) {
        const triResults = ctx.db.searchTrigram(q, { ...filterOpts, framework: fw })
        addResults(triResults, 'substring')
      }
    } catch {}
  }

  // Tier 3: Levenshtein fuzzy (if < 5 results and query >= 4 chars)
  if (results.length < 5 && q.length >= 4 && fuzzy) {
    const fuzzyMatches = fuzzyMatchTitles(q, ctx.db, { framework, kind, limit })
    for (const fm of fuzzyMatches) {
      if (seen.has(fm.id)) continue
      const record = ctx.db.getSearchRecordById(fm.id)
      if (!record) continue
      if (!matchesSourceFilter(record, sourceTypes)) continue
      if (seen.has(record.path)) continue
      seen.add(record.path)
      results.push({ ...formatResult(record), matchQuality: 'fuzzy', distance: fm.distance })
    }
  }

  // Body search: wait or cancel based on result count and flags
  if (bodyPromise) {
    if (results.length >= limit && !noEager) {
      bodyCancelled = true
    } else {
      const bodyResults = await bodyPromise
      addResults(bodyResults.filter(r => !seen.has(r.path)), 'body')
    }
  }

  // Intent detection + source-aware reranking
  const intent = detectIntent(q)
  rerank(results, q, intent)

  // Post-filter by WWDC year/track from sourceMetadata (enables search_wwdc consolidation)
  if (opts.year || opts.track) {
    const before = results.length
    for (let i = results.length - 1; i >= 0; i--) {
      try {
        const meta = JSON.parse(results[i].sourceMetadata ?? '{}')
        if (opts.year && meta.year !== opts.year) { results.splice(i, 1); continue }
        if (opts.track && meta.track && !meta.track.toLowerCase().includes(opts.track.toLowerCase())) { results.splice(i, 1); continue }
      } catch { results.splice(i, 1) }
    }
  }

  const sliced = results.slice(0, limit)

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
    docKind: r.doc_kind ?? null,
    language: r.language ?? null,
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

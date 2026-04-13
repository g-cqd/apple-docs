import { fuzzyMatchTitles } from '../lib/fuzzy.js'

const TIER_LABELS = ['exact', 'prefix', 'contains', 'match']

/**
 * Search with tiered cascade: FTS5 → trigram → fuzzy → body (background).
 *
 * @param {{ query: string, framework?: string, kind?: string, limit?: number,
 *           fuzzy?: boolean, noDeep?: boolean, noEager?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function search(opts, ctx) {
  const { query, kind } = opts
  const limit = Math.max(parseInt(opts.limit) || 100, 1)
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

  if (!query?.trim()) return { results: [], total: 0, query: '' }

  const q = query.trim()
  const ftsQuery = buildFtsQuery(q)
  const filterOpts = { framework, kind, limit: searchLimit }

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
          resolve(ctx.db.searchBody(ftsQuery, filterOpts))
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
    const ftsResults = ctx.db.searchPages(ftsQuery, q, filterOpts)
    for (const r of ftsResults) {
      if (seen.has(r.path)) continue
      seen.add(r.path)
      results.push({ ...formatResult(r), matchQuality: TIER_LABELS[r.tier] ?? 'match' })
    }
  } catch {
    // FTS5 query syntax error — try simpler query
    try {
      const simple = `"${q.replace(/"/g, '')}"*`
      const ftsResults = ctx.db.searchPages(simple, q, filterOpts)
      addResults(ftsResults, 'match')
    } catch {}
  }

  // Tier 2: Trigram substring (if < 5 results and query >= 3 chars)
  if (results.length < 5 && q.length >= 3) {
    try {
      const triResults = ctx.db.searchTrigram(q, filterOpts)
      addResults(triResults, 'substring')
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

  // Sort: exact first, then prefix, contains, match, substring, fuzzy, body
  const qualityOrder = { exact: 0, prefix: 1, contains: 2, match: 3, substring: 4, fuzzy: 5, body: 6 }
  results.sort((a, b) => (qualityOrder[a.matchQuality] ?? 9) - (qualityOrder[b.matchQuality] ?? 9))

  return {
    results: results.slice(0, limit),
    total: results.length,
    query,
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
  return unique.slice(0, -1).map(t => `"${t}"`).join(' ') + ` "${unique.at(-1)}"*`
}

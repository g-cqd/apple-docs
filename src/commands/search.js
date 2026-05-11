import { renderSnippet } from '../content/render-snippet.js'
import { detectIntent } from '../search/intent.js'
import { rerank } from '../search/ranking.js'
import { buildCascadeRunners, runRelaxationCascade } from '../search/cascade.js'
import {
  buildPlatformFilters,
  matchesSearchFilters,
  normalizeDeprecatedFilter,
  normalizeSourceFilter,
} from '../search/filters.js'
import { formatResult } from '../search/format.js'
import { buildFtsQuery } from '../search/fts-query-builder.js'
import { runRead, DeadlineError } from '../storage/reader-pool.js'

const TIER_LABELS = ['exact', 'prefix', 'contains', 'match']

/**
 * Search with tiered cascade: fast title/path tiers first, deep body search only
 * when needed.
 *
 * Tiers 1 (FTS5) and 2 (trigram) run eagerly on the default command path.
 * Latency-sensitive callers can set `fast: true` to try exact-title and FTS
 * first, then trigram only if the requested window is not filled. Tier 3
 * (fuzzy) runs sequentially only when fast tiers produce very few results.
 * Tier 4 (body) runs only when the requested result window is not already
 * satisfied, or when explicitly forced with `noEager`.
 *
 * @param {{ query: string, framework?: string, kind?: string, limit?: number,
 *           offset?: number, fuzzy?: boolean, noDeep?: boolean, noEager?: boolean,
 *           fast?: boolean,
 *           source?: string, language?: string, platform?: string,
 *           minIos?: string, minMacos?: string, minWatchos?: string,
 *           minTvos?: string, minVisionos?: string }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function search(opts, ctx) {
  const { query, kind } = opts
  const limit = Math.max(Number.parseInt(opts.limit, 10) || 100, 1)
  const offset = Math.max(Number.parseInt(opts.offset, 10) || 0, 0)
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
  const fast = !!opts.fast

  // Language and platform version filters
  const language = opts.language ?? null
  const minIos = opts.minIos ?? opts['min-ios'] ?? null
  const minMacos = opts.minMacos ?? opts['min-macos'] ?? null
  const minWatchos = opts.minWatchos ?? opts['min-watchos'] ?? null
  const minTvos = opts.minTvos ?? opts['min-tvos'] ?? null
  const minVisionos = opts.minVisionos ?? opts['min-visionos'] ?? null

  const platform = opts.platform ?? null
  const platformFilters = buildPlatformFilters(platform, { minIos, minMacos, minWatchos, minTvos, minVisionos })
  const deprecated = normalizeDeprecatedFilter(opts.deprecated)
  // Only `kind` and platform-version filters stay JS-side. sourceTypes
  // IN, year, track substring, and deprecated mode push down to SQL via
  // FILTER_PREDICATES, so the over-fetch multiplier sits at 3× for the
  // common multi-source / deprecated-exclude queries and 1× when no JS
  // filters apply at all.
  const hasJsPostFilters = !!kind
    || Object.values(platformFilters).some(Boolean)
  const searchLimit = hasJsPostFilters ? Math.min(Math.max(requestedWindow * 3, 60), 300) : requestedWindow

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

  // Push every multi-valued / metadata filter into SQL. The residual
  // `activeFilters` is consulted post-cascade only for checks SQL
  // can't cheaply express (kind taxonomy heuristic + explicit-
  // platform-only sentinel).
  const sqlSourceType = sourceTypes?.size === 1 ? [...sourceTypes][0] : null
  const filterOpts = {
    limit: searchLimit,
    language,
    sourceType: sqlSourceType,
    sources: sourceTypes,
    year: typeof opts.year === 'number' ? opts.year : null,
    track: opts.track ?? null,
    deprecatedMode: deprecated,
  }
  const activeFilters = { frameworks, sourceTypes, kind, language, platformFilters, year: opts.year, track: opts.track, deprecated }

  const results = []
  const seen = new Set()

  // Parse platforms_json once per row at arrival without mutating the
  // row's `platforms` field. `r.platforms` stays a string (the JIT-
  // stable shape sees one type for that property); the parsed Array
  // lives on `r.platformsParsed`. Filters and `formatResult` read
  // `platformsParsed` first.
  const parseRowPlatforms = (rows) => {
    for (const r of rows) {
      if (r.platformsParsed !== undefined) continue
      if (typeof r.platforms === 'string') {
        try { r.platformsParsed = JSON.parse(r.platforms) } catch { r.platformsParsed = null }
      } else if (Array.isArray(r.platforms)) {
        r.platformsParsed = r.platforms
      } else {
        r.platformsParsed = null
      }
    }
  }

  const addResults = (rows, quality) => {
    parseRowPlatforms(rows)
    for (const r of rows) {
      if (!matchesSearchFilters(r, activeFilters)) continue
      if (seen.has(r.path)) continue
      seen.add(r.path)
      results.push(formatResult(r, quality))
    }
  }

  // Tier 4 metadata check stays on main thread — one cheap call.
  const hasBody = !noDeep && ctx.db.getBodyIndexCount() > 0
  const { runFts, runTitleExact, runTrigram, runBody } = buildCascadeRunners({
    ctx, q, ftsQuery, frameworks, filterOpts, hasBody,
  })

  // --- Fast phase: T1 (FTS5) and T2 (trigram) ---
  //
  // When the user narrowed the search (framework / kind / source) AND the
  // strict tiers already returned at least one hit, skip trigram. Inside a
  // narrowing scope the FTS hit count is naturally small and never fills
  // the requested window, but trigram fall-through doesn't add useful
  // results — fuzzy substring matches inside that scope are mostly noise.
  const userNarrowedScope = !!framework || !!kind || !!sqlSourceType
  addResults(await runTitleExact(), 'exact')
  let ftsResults = []
  let triResults = []
  if (fast && results.length >= requestedWindow) {
    // Already filled — skip both fast tiers.
  } else if (fast) {
    ftsResults = await runFts()
    const filledWindow = ftsResults.length >= requestedWindow
    const trustNarrowedHits = userNarrowedScope && (results.length + ftsResults.length) > 0
    triResults = (filledWindow || trustNarrowedHits) ? [] : await runTrigram()
  } else {
    const fastParts = await Promise.all([runFts(), runTrigram()])
    ftsResults = fastParts[0]
    triResults = fastParts[1]
  }

  // Merge T1 (FTS) results with tier labels. Tier labels come from the
  // SQL CASE in repos/search.js, so we can't use addResults' uniform
  // 'matchQuality' — the platforms pre-parse runs inline instead.
  parseRowPlatforms(ftsResults)
  for (const r of ftsResults) {
    if (!matchesSearchFilters(r, activeFilters)) continue
    if (seen.has(r.path)) continue
    seen.add(r.path)
    results.push(formatResult(r, TIER_LABELS[r.tier] ?? 'match'))
  }

  // Merge T2 (trigram) results, skipping already-seen.
  addResults(triResults, 'substring')

  // Track which deep contributions timed out so the response envelope
  // can flag `partial: true`. A deadline expiration on fuzzy or body
  // is *expected* under load (the deep pool is intentionally smaller
  // than strict); the strict cascade already produced usable results
  // above and we surface those rather than blocking on the deep
  // contribution.
  let partial = false
  const partialReasons = []

  // Tier 3: Levenshtein fuzzy (only if T1+T2 combined < 5 and query >= 4 chars).
  // The fuzzy scan can run in a reader-pool worker concurrently; per-id
  // record fetches are parallelized so the pool fans them out.
  if (results.length < 5 && q.length >= 4 && fuzzy) {
    try {
      const fuzzyMatches = await runRead(ctx, 'fuzzyMatchTitles', [q, { framework, kind, limit: searchLimit }])
      const fuzzyRecords = await Promise.all(
        fuzzyMatches.map(fm => runRead(ctx, 'getSearchRecordById', [fm.id]).then(record => ({ fm, record }))),
      )
      parseRowPlatforms(fuzzyRecords.map(({ record }) => record).filter(Boolean))
      for (const { fm, record } of fuzzyRecords) {
        if (!record) continue
        if (!matchesSearchFilters(record, activeFilters)) continue
        if (seen.has(record.path)) continue
        seen.add(record.path)
        results.push(formatResult(record, 'fuzzy', fm.distance))
      }
    } catch (err) {
      if (err instanceof DeadlineError) {
        partial = true
        partialReasons.push('fuzzy')
      } else {
        ctx.logger?.warn?.('search fuzzy failed', { error: err.message })
      }
    }
  }

  // Body search: merge or discard if we already have enough.
  if (hasBody && (results.length < requestedWindow || noEager)) {
    try {
      addResults(await runBody(), 'body')
    } catch (err) {
      if (err instanceof DeadlineError) {
        partial = true
        partialReasons.push('body')
      } else {
        ctx.logger?.warn?.('search body failed', { error: err.message })
      }
    }
  }

  // Progressive relaxation: only runs when the strict cascade produced
  // nothing and the query is a multi-word natural-language phrase.
  const relaxationTier = await runRelaxationCascade({
    ctx, q, frameworks, filterOpts, results, addResults,
  })

  // Intent detection + source-aware reranking
  const intent = detectIntent(q)
  rerank(results, q, intent)

  const sliced = results.slice(offset, offset + limit)

  // Batch-fetch snippet data and related counts for final results.
  // Snippet/related enrichment is non-critical — best-effort, swallow
  // failures so a missing sections table on the lite tier doesn't sink
  // the whole response.
  try {
    const resultKeys = sliced.map(r => r.path)
    const snippetData = ctx.db.getDocumentSnippetData(resultKeys)
    const relatedCounts = ctx.db.getRelatedDocCounts(resultKeys)
    for (const r of sliced) {
      const data = snippetData.get(r.path)
      if (data) r.snippet = renderSnippet(data.document, data.sections, q)
      r.relatedCount = relatedCounts.get(r.path) ?? 0
    }
  } catch {
    // Best-effort: snippet failure shouldn't sink the response.
  }

  return {
    results: sliced,
    total: results.length,
    query,
    intent,
    ...(relaxationTier != null ? { relaxed: true, relaxationTier } : {}),
    ...(partial ? { partial: true, partialReasons } : {}),
    tier: ctx.db.getTier(),
    trigramAvailable: ctx.db.hasTable('documents_trigram'),
    bodyIndexAvailable: hasBody,
  }
}

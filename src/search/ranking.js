const BASE_SCORES = {
  exact: 100,
  prefix: 80,
  contains: 60,
  match: 50,
  substring: 30,
  fuzzy: 20,
  body: 10,
}

const SYMBOL_KINDS = new Set([
  'symbol', 'class', 'structure', 'protocol', 'enum', 'enumeration',
  'property wrapper', 'type alias', 'function', 'method',
])

const SOURCE_PREFERENCE_MULTIPLIERS = {
  'apple-docc': 1.3,
  hig: 1.2,
  'sample-code': 1.12,
  guidelines: 1.05,
}

const SOURCE_PREFERENCE_ORDER = {
  'apple-docc': 0,
  hig: 1,
  'sample-code': 2,
  guidelines: 3,
}

/**
 * Apply source-aware reranking rules to search results.
 *
 * @param {Array} results - Search results with matchQuality, sourceType, path, kind, title, etc.
 * @param {string} query - Original query string
 * @param {{ type: string, confidence: number }} intent - Detected query intent
 * @returns {Array} Results with `score` field, sorted by score descending
 */
export function rerank(results, query, intent) {
  const lowerQuery = (query ?? '').toLowerCase()

  for (const r of results) {
    const sourceType = (r.sourceType ?? '').toLowerCase()
    let score = BASE_SCORES[r.matchQuality] ?? 50

    // R1: Exact path/identifier match
    const lastSegment = r.path?.split('/').pop()?.toLowerCase() ?? ''
    if (lastSegment === lowerQuery || (r.title ?? '').toLowerCase() === lowerQuery) {
      score *= 3.0
    }

    // R2: Symbol kind boost — when intent is symbol and result is a symbol kind
    if (intent.type === 'symbol') {
      const kind = (r.kind ?? r.docKind ?? '').toLowerCase()
      if (SYMBOL_KINDS.has(kind)) {
        score *= 1.5
      }
    }

    // R3: Guide/article boost — when intent is howto
    if (intent.type === 'howto') {
      const kind = (r.kind ?? r.docKind ?? '').toLowerCase()
      if (sourceType === 'hig' || sourceType === 'guidelines' || kind === 'article') {
        score *= 1.3
      }
    }

    // R4: Release notes penalty
    if (r.isReleaseNotes || (r.path ?? '').includes('release-notes')) {
      score *= 0.4
    }

    // R5: Archived content penalty
    if (sourceType === 'apple-archive') {
      score *= 0.6
    }

    // R6: Code example boost — when intent is howto or query mentions "example"
    if (sourceType === 'sample-code') {
      if (intent.type === 'howto' || lowerQuery.includes('example') || lowerQuery.includes('sample')) {
        score *= 1.2
      }
    }

    // R6b: Package catalog penalty — keep third-party package READMEs from
    // crowding out official docs unless the query is strongly package-specific.
    if (sourceType === 'packages') {
      score *= 0.45
      if (
        lowerQuery.includes('package')
        || lowerQuery.includes('library')
        || (r.title ?? '').toLowerCase() === lowerQuery
      ) {
        score *= 1.5
      }
    }

    // R7: Preferred source ordering — when matches are otherwise comparable,
    // prefer official Apple DocC first, then HIG, sample code, and App Store Review.
    score *= SOURCE_PREFERENCE_MULTIPLIERS[sourceType] ?? 1.0

    // R8: Depth penalty — deeper pages are generally less relevant
    const depth = r.urlDepth ?? 0
    if (depth > 0) {
      score *= Math.max(0.3, 1.0 - depth * 0.05)
    }

    // R9: Error intent — boost articles about errors and troubleshooting
    if (intent.type === 'error') {
      const kind = (r.kind ?? r.docKind ?? '').toLowerCase()
      const title = (r.title ?? '').toLowerCase()
      if (kind === 'article' || title.includes('error') || title.includes('troubleshoot')) {
        score *= 1.2
      }
    }

    // R10: Concept intent — boost guides, articles, and conceptual content
    if (intent.type === 'concept') {
      const kind = (r.kind ?? r.docKind ?? '').toLowerCase()
      if (kind === 'article' || sourceType === 'hig' || sourceType === 'swift-book') {
        score *= 1.2
      }
    }

    // R11: WWDC intent — boost WWDC sessions when query is WWDC-related
    if (intent.type === 'wwdc' && sourceType === 'wwdc') {
      score *= 1.4
    }

    r.score = score
  }

  // Stable sort: by score descending, then by original match quality order for ties
  const qualityOrder = { exact: 0, prefix: 1, contains: 2, match: 3, substring: 4, fuzzy: 5, body: 6 }
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff
    const qualityDiff = (qualityOrder[a.matchQuality] ?? 9) - (qualityOrder[b.matchQuality] ?? 9)
    if (qualityDiff !== 0) return qualityDiff
    return (SOURCE_PREFERENCE_ORDER[a.sourceType?.toLowerCase()] ?? 99) - (SOURCE_PREFERENCE_ORDER[b.sourceType?.toLowerCase()] ?? 99)
  })

  return results
}

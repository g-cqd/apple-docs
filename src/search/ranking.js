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

const FRESH_SOURCES = new Set(['apple-docc', 'swift-book', 'swift-org'])

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
      const st = (r.sourceType ?? '').toLowerCase()
      const kind = (r.kind ?? r.docKind ?? '').toLowerCase()
      if (st === 'hig' || st === 'guidelines' || kind === 'article') {
        score *= 1.3
      }
    }

    // R4: Release notes penalty
    if (r.isReleaseNotes || (r.path ?? '').includes('release-notes')) {
      score *= 0.4
    }

    // R5: Archived content penalty
    if ((r.sourceType ?? '').toLowerCase() === 'apple-archive') {
      score *= 0.6
    }

    // R6: Code example boost — when intent is howto or query mentions "example"
    if ((r.sourceType ?? '').toLowerCase() === 'sample-code') {
      if (intent.type === 'howto' || lowerQuery.includes('example') || lowerQuery.includes('sample')) {
        score *= 1.2
      }
    }

    // R7: Depth penalty — deeper pages are generally less relevant
    const depth = r.urlDepth ?? 0
    if (depth > 0) {
      score *= Math.max(0.3, 1.0 - depth * 0.05)
    }

    // R8: Source freshness boost — actively maintained sources
    if (FRESH_SOURCES.has((r.sourceType ?? '').toLowerCase())) {
      score *= 1.1
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
      const st = (r.sourceType ?? '').toLowerCase()
      if (kind === 'article' || st === 'hig' || st === 'swift-book') {
        score *= 1.2
      }
    }

    r.score = score
  }

  // Stable sort: by score descending, then by original match quality order for ties
  const qualityOrder = { exact: 0, prefix: 1, contains: 2, match: 3, substring: 4, fuzzy: 5, body: 6 }
  results.sort((a, b) => {
    const scoreDiff = b.score - a.score
    if (Math.abs(scoreDiff) > 0.001) return scoreDiff
    return (qualityOrder[a.matchQuality] ?? 9) - (qualityOrder[b.matchQuality] ?? 9)
  })

  return results
}

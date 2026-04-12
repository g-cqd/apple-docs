/**
 * Levenshtein edit distance with early exit.
 * Returns maxDist + 1 if distance exceeds maxDist (avoids full computation).
 */
export function levenshtein(a, b, maxDist = 2) {
  const m = a.length, n = b.length
  if (Math.abs(m - n) > maxDist) return maxDist + 1
  if (m === 0) return n
  if (n === 0) return m

  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    let rowMin = i
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1])
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > maxDist) return maxDist + 1
    prev = curr
  }
  return prev[n]
}

/**
 * Extract character trigrams from a string.
 */
export function trigrams(s) {
  const lower = s.toLowerCase()
  const set = new Set()
  for (let i = 0; i <= lower.length - 3; i++) {
    set.add(lower.slice(i, i + 3))
  }
  return set
}

/**
 * Find fuzzy title matches using trigram pre-filter + Levenshtein.
 * @param {string} query - The user's search query
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {{ framework?: string, kind?: string, limit?: number, maxDist?: number }} opts
 * @returns {Array<{ id: number, title: string, distance: number }>}
 */
export function fuzzyMatchTitles(query, db, { framework, kind, limit = 100, maxDist = 2 } = {}) {
  const queryTrigrams = trigrams(query)
  if (queryTrigrams.size < 2) return []

  // Collect candidates from trigram index: titles sharing any trigram with query
  const hits = new Map() // id → { title, count }
  for (const tri of queryTrigrams) {
    for (const row of db.getTrigramCandidates(tri)) {
      const existing = hits.get(row.id)
      if (existing) {
        existing.count++
      } else {
        hits.set(row.id, { title: row.title, count: 1 })
      }
    }
  }

  // Require >= 40% trigram overlap to be a candidate
  const minHits = Math.max(1, Math.floor(queryTrigrams.size * 0.4))
  const queryLower = query.toLowerCase()

  const matches = []
  for (const [id, { title, count }] of hits) {
    if (count < minHits) continue
    const distance = levenshtein(queryLower, title.toLowerCase(), maxDist)
    if (distance <= maxDist) {
      matches.push({ id, title, distance })
    }
  }

  matches.sort((a, b) => a.distance - b.distance)
  return matches.slice(0, limit)
}

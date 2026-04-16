/**
 * Levenshtein edit distance with early exit.
 * Returns maxDist + 1 if distance exceeds maxDist (avoids full computation).
 */
function levenshtein(a, b, maxDist = 2) {
  const m = a.length
  const n = b.length
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
function trigrams(s) {
  const lower = s.toLowerCase()
  const set = new Set()
  for (let i = 0; i <= lower.length - 3; i++) {
    set.add(lower.slice(i, i + 3))
  }
  return set
}

/**
 * Module-level trigram cache: lazily built on first fuzzy search per db instance.
 * Maps trigram string -> array of { id, title } rows.
 * Automatically invalidated when a different db instance is used.
 * @type {Map<string, Array<{ id: number, title: string }>> | null}
 */
let _trigramCache = null
/** @type {object | null} */
let _trigramCacheDb = null

/**
 * Build the trigram cache from the database's trigram index.
 * Groups all trigram candidates by trigram string for O(1) lookup.
 */
function buildTrigramCache(db) {
  _trigramCache = new Map()
  _trigramCacheDb = db
  // Get all titles from the database and build trigrams locally
  const allTitles = db.getAllTitlesForFuzzy()
  for (const row of allTitles) {
    const titleTrigrams = trigrams(row.title)
    for (const tri of titleTrigrams) {
      let bucket = _trigramCache.get(tri)
      if (!bucket) {
        bucket = []
        _trigramCache.set(tri, bucket)
      }
      bucket.push({ id: row.id, title: row.title })
    }
  }
}

/**
 * Find fuzzy title matches using trigram pre-filter + Levenshtein.
 * Caches trigram sets on first call for fast subsequent lookups.
 * @param {string} query - The user's search query
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {{ framework?: string, kind?: string, limit?: number, maxDist?: number, excludeIds?: Set<string> }} opts
 * @returns {Array<{ id: number, title: string, distance: number }>}
 */
export function fuzzyMatchTitles(query, db, { framework: _framework, kind: _kind, limit = 100, maxDist = 2, excludeIds = null } = {}) {
  const queryTrigrams = trigrams(query)
  if (queryTrigrams.size < 2) return []

  // Lazy-init: build trigram cache on first call, or rebuild if db instance changed
  if (!_trigramCache || _trigramCacheDb !== db) {
    buildTrigramCache(db)
  }

  // Collect candidates from cached trigrams: titles sharing any trigram with query
  const hits = new Map() // id -> { title, count }
  for (const tri of queryTrigrams) {
    const bucket = _trigramCache.get(tri)
    if (!bucket) continue
    for (const row of bucket) {
      if (excludeIds && excludeIds.has(row.id)) continue
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

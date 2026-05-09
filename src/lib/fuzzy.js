import { statSync } from 'node:fs'

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
 * Module-level trigram cache: lazily built on first fuzzy search per db
 * instance, invalidated on corpus change.
 *
 * P2.9: previously the cache was held forever once built — long-lived MCP
 * HTTP processes would never see new docs from a parallel `apple-docs sync`
 * because nothing rebuilt the in-memory map. The fix stamps the cache with
 * a `(schemaVersion, dbMtime)` snapshot on build; each query re-reads the
 * stamp (capped at STAMP_TTL_MS to avoid syscalling on every keystroke)
 * and rebuilds if it changed.
 *
 * Memory pressure isn't the priority here (64 GB RAM in production) —
 * staleness is. Keeping the in-memory Map is the right tradeoff vs.
 * per-query SQL.
 *
 * @type {Map<string, Array<{ id: number, title: string }>> | null}
 */
let _trigramCache = null
/** @type {object | null} */
let _trigramCacheDb = null
/** @type {string | null} */
let _trigramCacheStamp = null
/** @type {number} */
let _trigramStampReadAt = 0

const STAMP_TTL_MS = 5_000

function readDbMtime(db) {
  try {
    const path = db?.dbPath
    if (!path || path === ':memory:') return 0
    return Math.floor(statSync(path).mtimeMs)
  } catch {
    return 0
  }
}

function readSchemaVersion(db) {
  try { return db?.getSchemaVersion?.() ?? 0 } catch { return 0 }
}

function corpusStamp(db) {
  return `${readSchemaVersion(db)}:${readDbMtime(db)}`
}

/**
 * Build the trigram cache from the database's trigram index.
 * Groups all trigram candidates by trigram string for O(1) lookup.
 */
function buildTrigramCache(db) {
  _trigramCache = new Map()
  _trigramCacheDb = db
  _trigramCacheStamp = corpusStamp(db)
  _trigramStampReadAt = Date.now()
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

/** Test-only hook: drop the cache so fixtures can rebuild deterministically. */
export function _resetTrigramCache() {
  _trigramCache = null
  _trigramCacheDb = null
  _trigramCacheStamp = null
  _trigramStampReadAt = 0
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

  // Lazy-init: build trigram cache on first call, or rebuild if db
  // instance changed OR the corpus stamp drifted (P2.9). The stamp re-read
  // is rate-limited to STAMP_TTL_MS so high-RPS callers don't pay a
  // statSync per query.
  const dbChanged = _trigramCacheDb !== db
  let stampDrifted = false
  if (!dbChanged && _trigramCache) {
    const now = Date.now()
    if (now - _trigramStampReadAt >= STAMP_TTL_MS) {
      const currentStamp = corpusStamp(db)
      _trigramStampReadAt = now
      stampDrifted = currentStamp !== _trigramCacheStamp
      _trigramCacheStamp = currentStamp
    }
  }
  if (!_trigramCache || dbChanged || stampDrifted) {
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

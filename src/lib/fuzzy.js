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
 * Build an FTS5 OR-of-trigrams MATCH expression. Each trigram is
 * double-quoted to disable FTS5's special characters (`-`, `:`, etc.)
 * and joined with explicit OR. Empty input → null (caller should skip
 * the SQL entirely).
 */
function buildTrigramOrQuery(triSet) {
  if (triSet.size === 0) return null
  const parts = []
  for (const tri of triSet) parts.push(`"${tri.replace(/"/g, '""')}"`)
  return parts.join(' OR ')
}

/**
 * P3.2: no-op kept for test compatibility. The pre-P3.2
 * implementation built a process-local Map<trigram, [docs]> and this
 * helper let fixtures drop it between cases. The SQL-backed path
 * holds no module-level state; the export remains so the test
 * harness import doesn't break.
 */
export function _resetTrigramCache() { /* no-op since P3.2 */ }

/**
 * Find fuzzy title matches using a SQL-backed trigram pre-filter
 * plus a JS Levenshtein post-filter (P3.2).
 *
 * Pre-P3.2 this kept a process-local `Map<trigram, [{id, title}]>`
 * built from every title (multi-hundred-MB warm RSS per reader
 * worker, stale-on-write hazard). The SQL path reads the live
 * `documents_trigram` FTS5 index per call: cheap (~ms), always
 * fresh, no warm-up cost.
 *
 * @param {string} query
 * @param {import('../storage/database.js').DocsDatabase} db
 * @param {{ framework?: string, kind?: string, limit?: number, maxDist?: number, excludeIds?: Set<string|number> }} opts
 * @returns {Array<{ id: number, title: string, distance: number }>}
 */
export function fuzzyMatchTitles(query, db, { framework: _framework, kind: _kind, limit = 100, maxDist = 2, excludeIds = null } = {}) {
  const queryTrigrams = trigrams(query)
  if (queryTrigrams.size < 2) return []
  const orQuery = buildTrigramOrQuery(queryTrigrams)
  if (!orQuery) return []

  // Over-fetch on the SQL side so we have room for the Levenshtein
  // post-filter to discard non-matches. 500 is generous; bm25
  // ordering puts the highest-trigram-overlap titles first so the
  // tail beyond N is unlikely to contain real matches.
  const sqlLimit = Math.max(limit * 5, 100)
  const candidates = db.fuzzyTrigramCandidates?.(orQuery, sqlLimit) ?? []

  // Fallback path for hosts without the trigram FTS5 table (in-memory
  // tests, schema < v6). Scan every title — slow on a real corpus,
  // negligible on the small fixtures that hit this branch.
  const useFallback = candidates.length === 0 && typeof db.fuzzyTrigramCandidates !== 'function'
  const rows = useFallback ? (db.getAllTitlesForFuzzy?.() ?? []) : candidates

  const queryLower = query.toLowerCase()
  const matches = []
  for (const row of rows) {
    if (!row?.title) continue
    if (excludeIds && excludeIds.has(row.id)) continue
    const distance = levenshtein(queryLower, row.title.toLowerCase(), maxDist)
    if (distance <= maxDist) {
      matches.push({ id: row.id, title: row.title, distance })
    }
  }

  matches.sort((a, b) => a.distance - b.distance)
  return matches.slice(0, limit)
}

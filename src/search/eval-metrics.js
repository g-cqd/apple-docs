/**
 * Pure ranking-quality metrics for the search eval harness (no deps).
 *
 * All three take an ordered `retrieved` list (best-first, e.g. result paths or
 * document ids) and a `relevant` set/array of the judged-relevant keys. They
 * never read the DB — the harness in scripts/eval-search.js feeds them search
 * output so quality is gated by numbers on our own corpus, not generic MTEB.
 */

/** Coerce `relevant` (Set | Array | iterable) to a Set for O(1) membership. */
function toSet(relevant) {
  return relevant instanceof Set ? relevant : new Set(relevant ?? [])
}

/**
 * recall@k — fraction of the relevant items that appear in the top-k retrieved.
 * @param {Array<string|number>} retrieved best-first ranked keys
 * @param {Set|Array} relevant judged-relevant keys
 * @param {number} [k=10]
 * @returns {number} 0..1 (0 when nothing is relevant)
 */
export function recallAtK(retrieved, relevant, k = 10) {
  const rel = toSet(relevant)
  if (rel.size === 0) return 0
  const top = (retrieved ?? []).slice(0, k)
  let hit = 0
  for (const key of top) if (rel.has(key)) hit++
  return hit / rel.size
}

/**
 * nDCG@k with binary relevance. DCG sums 1/log2(rank+1) over relevant hits in
 * the top-k; IDCG is the best achievable given how many relevant docs exist.
 * @param {Array<string|number>} retrieved
 * @param {Set|Array} relevant
 * @param {number} [k=10]
 * @returns {number} 0..1
 */
export function ndcgAtK(retrieved, relevant, k = 10) {
  const rel = toSet(relevant)
  if (rel.size === 0) return 0
  const top = (retrieved ?? []).slice(0, k)
  let dcg = 0
  for (let i = 0; i < top.length; i++) {
    if (rel.has(top[i])) dcg += 1 / Math.log2(i + 2)
  }
  const ideal = Math.min(k, rel.size)
  let idcg = 0
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

/**
 * Mean Reciprocal Rank for a single query: 1/(rank of first relevant hit), or
 * 0 when no relevant item is retrieved. Average across queries in the harness.
 * @param {Array<string|number>} retrieved
 * @param {Set|Array} relevant
 * @returns {number} 0..1
 */
export function mrr(retrieved, relevant) {
  const rel = toSet(relevant)
  if (rel.size === 0) return 0
  const list = retrieved ?? []
  for (let i = 0; i < list.length; i++) {
    if (rel.has(list[i])) return 1 / (i + 1)
  }
  return 0
}

/** Mean of a numeric array (0 for empty) — small helper the harness reuses. */
export function mean(values) {
  if (!values || values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

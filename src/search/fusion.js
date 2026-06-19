/**
 * Result fusion for the hybrid lexical + semantic tier.
 *
 * `weightedRRF` fuses on *rank* alone — robust when score scales are
 * incompatible (lexical bm25 vs Hamming distance) but it throws away the
 * magnitude of the semantic match. `hybridFusion` keeps the rank-fusion
 * backbone and *adds* a normalized-score term, so a strongly-similar semantic
 * hit can climb while a weak one stays put. `mmrSelect` then re-orders the top
 * window for diversity, collapsing the near-duplicate "symbol overload" that
 * semantic recall tends to surface.
 */

/**
 * Weighted Reciprocal Rank Fusion. Sums `weight / (k + rank)` per item using
 * ranks (not scores). Weighting lexical above semantic keeps exact symbol
 * matches — which sit at lexical rank 0 — on top.
 *
 * @param {Array<{ ranked: string[], weight: number }>} lists ranked key lists
 * @param {{ k?: number }} [opts]
 * @returns {Map<string, number>} key → fused score (higher = better)
 */
export function weightedRRF(lists, { k = 60 } = {}) {
  const scores = new Map()
  for (const { ranked, weight } of lists) {
    for (let i = 0; i < ranked.length; i++) {
      const key = ranked[i]
      scores.set(key, (scores.get(key) ?? 0) + weight / (k + i + 1))
    }
  }
  return scores
}

/**
 * Min-max normalize a `key → score` map into [0, 1] (higher stays better).
 * A degenerate range (all equal, or ≤1 entry) maps every key to 0 so the
 * signal contributes nothing differential rather than a misleading constant.
 *
 * @param {Map<string, number>} map
 * @returns {Map<string, number>}
 */
export function normalizeScores(map) {
  const out = new Map()
  if (!map || map.size === 0) return out
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of map.values()) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const range = max - min
  for (const [k, v] of map) out.set(k, range > 0 ? (v - min) / range : 0)
  return out
}

/**
 * Score-aware fusion: weighted-RRF **plus** `beta · weight · normalizedScore`.
 * Lists without a `scores` map contribute rank only (so it degrades to
 * `weightedRRF`). Weighting the score term by the list weight preserves the
 * lexical-dominance invariant — an exact match (lexical normScore 1.0, weight
 * 1.0) still outranks a top semantic-only hit.
 *
 * @param {Array<{ ranked: string[], weight: number, scores?: Map<string, number> }>} lists
 * @param {{ k?: number, beta?: number }} [opts]
 * @returns {Map<string, number>}
 */
export function hybridFusion(lists, { k = 60, beta = 0.5 } = {}) {
  const fused = new Map()
  for (const { ranked, weight, scores } of lists) {
    const norm = scores ? normalizeScores(scores) : null
    for (let i = 0; i < ranked.length; i++) {
      const key = ranked[i]
      let add = weight / (k + i + 1)
      if (norm) add += beta * weight * (norm.get(key) ?? 0)
      fused.set(key, (fused.get(key) ?? 0) + add)
    }
  }
  return fused
}

/**
 * Maximal Marginal Relevance re-ranking of an already-ordered window. Greedy:
 * always keep the current best, then repeatedly pick the item maximizing
 * `λ · relevance − (1 − λ) · maxSimilarityToSelected`. Relevance is the item's
 * incoming rank (position-derived, [0, 1]) so the input order is honored.
 *
 * Items whose `vecOf` is null carry redundancy 0 → they are never demoted for
 * similarity. That keeps exact symbol matches (which have no semantic vector)
 * pinned where relevance put them while collapsing semantic near-duplicates.
 *
 * @template T
 * @param {T[]} ranked items in best-first order
 * @param {(item: T) => (Uint8Array|Float32Array|null)} vecOf vector accessor
 * @param {(a: any, b: any) => number} sim similarity in [0, 1]
 * @param {{ lambda?: number, limit?: number }} [opts]
 * @returns {T[]} re-ordered items
 */
export function mmrSelect(ranked, vecOf, sim, { lambda = 0.7, limit } = {}) {
  const n = ranked.length
  if (n <= 2) return ranked.slice()
  const cap = Math.min(limit ?? n, n)
  const rel = ranked.map((_, i) => (n - i) / n) // position-derived relevance
  const vecs = ranked.map(vecOf)
  const remaining = ranked.map((_, i) => i)
  /** @type {number[]} */
  const selected = []
  // Seed with the top item — nothing to be redundant against yet.
  const first = remaining.shift()
  if (first !== undefined) selected.push(first)
  while (selected.length < cap && remaining.length > 0) {
    let bestPos = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let p = 0; p < remaining.length; p++) {
      const i = remaining[p]
      const vi = vecs[i]
      let maxSim = 0
      if (vi) {
        for (const j of selected) {
          const vj = vecs[j]
          if (!vj) continue
          const s = sim(vi, vj)
          if (s > maxSim) maxSim = s
        }
      }
      const mmr = lambda * rel[i] - (1 - lambda) * maxSim
      if (mmr > bestScore) {
        bestScore = mmr
        bestPos = p
      }
    }
    const [next] = remaining.splice(bestPos, 1)
    if (next !== undefined) selected.push(next)
  }
  // Anything beyond the cap keeps its incoming order, appended after the window.
  return [...selected.map((i) => ranked[i]), ...remaining.map((i) => ranked[i])]
}

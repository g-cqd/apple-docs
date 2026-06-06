/**
 * Weighted Reciprocal Rank Fusion.
 *
 * RRF combines ranked lists by summing `weight / (k + rank)` per item, using
 * ranks (not scores) so incompatible score scales (lexical bm25 vs Hamming
 * distance) fuse cleanly. Weighting lexical above semantic keeps exact symbol
 * matches — which sit at lexical rank 0 — on top.
 *
 * @param {Array<{ ranked: string[], weight: number }>} lists  ranked key lists
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

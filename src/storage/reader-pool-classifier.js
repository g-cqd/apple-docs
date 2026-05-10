/**
 * Op-name classifier for the split reader-pool design (P2.1).
 *
 * Operations that historically took multi-second p99 — full-text body
 * search, fuzzy-title trigram lookup, body index counts — are routed
 * to a smaller `deep` pool so they cannot starve cheap title / FTS /
 * trigram reads on the `strict` pool.
 *
 * The list is deliberately conservative: only ops whose worst-case
 * cost is documented as 100s of ms or worse are flagged deep. Adding
 * a new method to the Set is the way to opt it into the deep pool.
 */

export const DEEP_OPS = Object.freeze(new Set([
  // Bottom-of-cascade body FTS — multi-second outliers in the
  // 2026-05-10 benchmark.
  'searchBody',
  'searchBodyAndEnrich',
  // Trigram-cache backed fuzzy match. Per-process Map of every title's
  // trigrams; expensive to walk under load.
  'fuzzyMatchTitles',
  // Body-index population check used by the deep cascade — cheap on
  // its own but always fires alongside body FTS, so route together.
  'getBodyIndexCount',
]))

/**
 * @param {string} op
 * @returns {'strict' | 'deep'}
 */
export function classifyOp(op) {
  return DEEP_OPS.has(op) ? 'deep' : 'strict'
}

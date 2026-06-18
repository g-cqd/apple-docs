/**
 * Map the internal search-cascade matchQuality enum to the public
 * three-level confidence field.
 *
 * Internal tiers emitted by src/commands/search.js:
 *   exact, prefix, contains, match (FTS5), substring (trigram),
 *   fuzzy (Levenshtein), body (full-text body), relaxed,
 *   relaxed-or, relaxed-token.
 *
 * Public confidence (the only value that leaves the process):
 *   exact       — title matched exactly.
 *   approximate — fuzzy match or relaxation-cascade fallback.
 *   partial     — every other tier; the query matched somewhere but
 *                 not as a title-exact hit.
 *
 * @param {unknown} matchQuality
 * @returns {'exact' | 'approximate' | 'partial'}
 */
export function publicConfidence(matchQuality) {
  if (matchQuality === 'exact') return 'exact'
  if (matchQuality === 'fuzzy') return 'approximate'
  if (typeof matchQuality === 'string' && matchQuality.startsWith('relaxed')) return 'approximate'
  return 'partial'
}

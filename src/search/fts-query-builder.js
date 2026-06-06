/**
 * Build an FTS5 MATCH expression from a user-supplied search string.
 *
 * Escape hatch: if the user typed an FTS5 operator (AND/OR/NOT) or a double
 * quote, the string is passed through verbatim — they know the mini-language.
 *
 * Otherwise each whitespace-separated word becomes a group and the groups are
 * AND-ed (every word must match). Within a word:
 *   - Qualified identifiers split on `. _ : /` into segments (e.g.
 *     `AVAudioSession.RouteSelection`). The segments are hierarchical
 *     alternatives, not all-required, so they OR together — each as a prefix,
 *     so `avaudiosessionrouteselection*` still matches a concatenated title
 *     token like `avaudiosessionrouteselectionexternal`. The concatenation of
 *     the segments is added too, so `Parent.Case` also matches a `ParentCase`
 *     title.
 *   - CamelCase identifiers contribute the whole word (prefix) plus their
 *     sub-words (exact), OR-ed, so `NavigationStack` matches the title token
 *     `navigationstack` directly in the FTS index (not only via title-exact).
 *
 * A word that yields a single token becomes `"token"*`; multiple become an
 * OR group `("a"* OR "b" OR ...)`. Multiple words AND their groups together.
 *
 * Hyphens are deliberately NOT separators: they appear in natural-language
 * queries ("in-app purchase", "Model-View-Controller") and proposal ids
 * ("SE-0296"), and unicode61 already splits on them at index time.
 *
 * Empty input yields `""` so the FTS5 parser doesn't reject an empty query.
 */

// Qualified-identifier separators. Hyphen is intentionally excluded (see above).
const QUALIFIER_SPLIT = /[._:/\\]+/

export function buildFtsQuery(q) {
  if (/\b(AND|OR|NOT)\b/.test(q) || q.includes('"')) return q

  const words = q.trim().split(/\s+/).filter(Boolean)
  const groups = words.map(buildWordGroup).filter(Boolean)
  if (groups.length === 0) return '""'
  return groups.join(' ')
}

/** Turn one whitespace-word into a single prefix term or an OR group. */
function buildWordGroup(word) {
  const segments = word.split(QUALIFIER_SPLIT).filter(Boolean)
  if (segments.length === 0) return null

  const prefixTerms = new Set() // matched as a prefix: "term"*
  const exactTerms = new Set() //  matched exactly:    "term"
  for (const seg of segments) {
    prefixTerms.add(seg.toLowerCase())
    for (const sub of camelSubwords(seg)) exactTerms.add(sub.toLowerCase())
  }
  // `Parent.Case` → also try `parentcase` (a concatenated title token).
  if (segments.length > 1) prefixTerms.add(segments.join('').toLowerCase())
  // A sub-word that's already a prefix term is redundant.
  for (const t of prefixTerms) exactTerms.delete(t)

  const alternatives = [
    ...[...prefixTerms].map(t => `"${t}"*`),
    ...[...exactTerms].map(t => `"${t}"`),
  ]
  if (alternatives.length === 0) return null
  if (alternatives.length === 1) return alternatives[0]
  return `(${alternatives.join(' OR ')})`
}

/** Split a CamelCase identifier into its sub-words (empty if it doesn't split). */
function camelSubwords(s) {
  const parts = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').filter(Boolean)
  return parts.length > 1 ? parts : []
}

/**
 * Sanitize a string for a trigram-table `MATCH`. Clean alphanumeric/space
 * queries pass through as FTS5 barewords (preserves the existing trigram-tier
 * behavior). Anything containing FTS5-significant characters (`.`, `:`, `(`,
 * …) is wrapped as a quoted phrase so the parser treats it literally instead
 * of throwing a "no such column" / syntax error on `.`-laden symbol queries.
 *
 * @param {string} q
 * @returns {string}
 */
export function sanitizeTrigramQuery(q) {
  const trimmed = String(q ?? '').trim()
  if (trimmed === '') return '""'
  if (/^[\w\s]+$/.test(trimmed)) return trimmed
  return `"${trimmed.replace(/"/g, '""')}"`
}

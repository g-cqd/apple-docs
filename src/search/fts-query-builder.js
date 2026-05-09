/**
 * Build an FTS5 query from a user-supplied search string.
 *
 * The FTS5 mini-language supports `AND/OR/NOT` and double-quoted phrases.
 * If the user typed any of those, pass the query through verbatim — they
 * know what they're doing. Otherwise, tokenize on whitespace, expand
 * CamelCase identifiers (`NavigationStack` → also `navigation`, `stack`),
 * deduplicate, and build:
 *   - `"term"*` for a single token (prefix match), or
 *   - `"a" "b" "c"*` for multiple tokens (AND with prefix on the last one).
 *
 * Empty input yields `""` so the FTS5 parser doesn't reject an empty query.
 */

export function buildFtsQuery(q) {
  if (/\b(AND|OR|NOT)\b/.test(q) || q.includes('"')) return q

  const terms = q.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return '""'

  // CamelCase expansion: "NavigationStack" → also search "navigation" "stack"
  const expanded = []
  for (const term of terms) {
    expanded.push(term)
    const split = term.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')
    if (split.length > 1) expanded.push(...split)
  }

  const unique = [...new Set(expanded.map(t => t.toLowerCase()))]

  if (unique.length === 1) return `"${unique[0]}"*`

  // All terms with prefix on last
  return `${unique.slice(0, -1).map(t => `"${t}"`).join(' ')} "${unique.at(-1)}"*`
}

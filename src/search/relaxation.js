/**
 * Progressive-relaxation helpers for long, natural-language search queries.
 *
 * When the strict tier cascade returns zero hits, `src/commands/search.js`
 * walks through three fallbacks (pruned AND → pruned OR → trigram on a single
 * high-signal token). These helpers isolate the tokenization rules so tests
 * can pin them independently.
 */

/**
 * Conservative English stopword list used to prune filler words from long
 * natural-language queries. Symbols, CamelCase, and identifier-like tokens are
 * kept by `pruneStopwords` regardless of membership here.
 */
export const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at',
  'be', 'but', 'by',
  'do', 'does',
  'for', 'from',
  'get',
  'have', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'me', 'my',
  'of', 'on', 'or',
  'should',
  'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to',
  'use', 'using',
  'want', 'was', 'way', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'why', 'will', 'with',
  'you', 'your',
])

const CAMEL_CASE = /[a-z][A-Z]/

/**
 * Split a raw query into tokens. Preserves original case so CamelCase can be
 * recognized later. Drops empty tokens and pure-numeric tokens shorter than
 * two characters.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function tokenize(query) {
  if (!query || typeof query !== 'string') return []
  return query
    .split(/[^\w.]+/)
    .filter(token => token.length > 0)
    .filter(token => !(/^\d$/.test(token)))
}

/**
 * Drop stopwords from a token list, keeping CamelCase identifiers intact even
 * if their lowercased form is in the stopword set.
 *
 * @param {string[]} tokens
 * @returns {string[]}
 */
export function pruneStopwords(tokens) {
  if (!Array.isArray(tokens)) return []
  return tokens.filter(token => {
    if (CAMEL_CASE.test(token)) return true
    return !SEARCH_STOPWORDS.has(token.toLowerCase())
  })
}

/**
 * Pick the highest-signal token for a last-resort trigram lookup.
 * Prefers the first CamelCase token; otherwise the longest token of length
 * four or more. Returns `null` when no token qualifies.
 *
 * @param {string[]} tokens
 * @returns {string|null}
 */
export function pickHighSignalToken(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null
  const camel = tokens.find(token => CAMEL_CASE.test(token))
  if (camel) return camel
  let best = null
  for (const token of tokens) {
    if (token.length < 4) continue
    if (!best || token.length > best.length) best = token
  }
  return best
}

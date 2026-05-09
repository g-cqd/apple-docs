// Shared constants + regex caches for the parse-html cluster.
// Pulled out of content/parse-html.js as part of Phase B.

/** Block-level HTML tags that should produce paragraph breaks. */
export const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'tr', 'blockquote', 'pre', 'section', 'article',
  'header', 'footer', 'nav', 'aside', 'main', 'figure',
  'figcaption', 'details', 'summary', 'ul', 'ol', 'dl',
  'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot',
])

/** Elements to strip entirely (including their content). */
export const STRIP_ELEMENTS = ['nav', 'header', 'footer', 'script', 'style', 'noscript']

const selectorIdRegexCache = new Map()
const selectorClassRegexCache = new Map()
const openTagRegexCache = new Map()

export const SECTION_SPLIT_REGEX_BY_TAG = {
  h2: /(<h2[\s>][\s\S]*?<\/h2>)/gi,
  h3: /(<h3[\s>][\s\S]*?<\/h3>)/gi,
}

export function getSelectorIdRegex(id) {
  if (!selectorIdRegexCache.has(id)) {
    selectorIdRegexCache.set(id, new RegExp(`\\bid\\s*=\\s*["']${escapeRegex(id)}["']`))
  }
  return selectorIdRegexCache.get(id)
}

export function getSelectorClassRegex(className) {
  if (!selectorClassRegexCache.has(className)) {
    selectorClassRegexCache.set(className, new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${escapeRegex(className)}\\b[^"']*["']`))
  }
  return selectorClassRegexCache.get(className)
}

export function getOpenTagRegex(tagPattern) {
  if (!openTagRegexCache.has(tagPattern)) {
    openTagRegexCache.set(tagPattern, new RegExp(`<(${tagPattern})\\b[^>]*>`, 'gi'))
  }
  return openTagRegexCache.get(tagPattern)
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

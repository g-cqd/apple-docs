import { renderPlainText } from './render-text.js'

// Snippets are ~220 chars; scanning (and lowercasing) more than this much
// document text per result buys nothing — the match window nearly always
// lands in the opening prose, and unmatched terms fall back to the intro
// truncation anyway.
const SNIPPET_SCAN_LIMIT = 16 * 1024

export function renderSnippet(document, sections = [], query = '', maxLength = 220) {
  let text = renderPlainText(document, sections)
  if (!text) return ''
  if (text.length > SNIPPET_SCAN_LIMIT) text = text.slice(0, SNIPPET_SCAN_LIMIT)

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map(term => term.replace(/[^\p{L}\p{N}_-]+/gu, ''))
    .filter(Boolean)

  if (terms.length === 0) {
    return truncate(text, maxLength)
  }

  const lower = text.toLowerCase()
  const hitIndex = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((a, b) => a - b)[0]

  if (hitIndex == null) {
    return truncate(text, maxLength)
  }

  const windowStart = Math.max(0, hitIndex - Math.floor(maxLength * 0.35))
  const windowEnd = Math.min(text.length, windowStart + maxLength)
  const slice = text.slice(windowStart, windowEnd).trim()
  const prefix = windowStart > 0 ? '...' : ''
  const suffix = windowEnd < text.length ? '...' : ''
  return `${prefix}${slice}${suffix}`
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

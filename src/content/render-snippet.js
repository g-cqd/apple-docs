import { renderPlainText } from './render-text.js'

export function renderSnippet(document, sections = [], query = '', maxLength = 220) {
  const text = renderPlainText(document, sections)
  if (!text) return ''

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

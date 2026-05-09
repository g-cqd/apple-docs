/**
 * Shared helpers for storage repos. Pulled out of database.js so each
 * repo can import without circular dependencies.
 */

export function parseJsonValue(value) {
  if (value == null) return null
  try { return JSON.parse(value) } catch { return null }
}

export function parseJsonArray(value) {
  const parsed = parseJsonValue(value)
  return Array.isArray(parsed) ? parsed : []
}

/**
 * Build an FTS5 MATCH query string for the resource (fonts / symbols)
 * indexes. Lowercases, splits on non-word punctuation (keeping `.-_`),
 * caps at 8 terms, escapes embedded quotes, and joins as an OR of
 * prefix matches. Empty input becomes `""` so the parser doesn't trip.
 */
export function buildResourceFtsQuery(query) {
  const terms = String(query)
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/i)
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 8)
  return terms.map(term => `"${term.replaceAll('"', '""')}"*`).join(' OR ') || '""'
}

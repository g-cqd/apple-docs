/**
 * Result-row formatter. Maps the wide search row produced by the storage
 * layer to the public CLI/MCP shape that the formatter / projection
 * layers expect.
 *
 * Pulled out of commands/search.js as part of P2.6.
 *
 * Phase 4.1 — JIT-friendly shape: every property is assigned in the
 * same order on every call, and `undefined`-valued conditionals stay
 * present on the literal so JavaScriptCore / V8 hidden-class
 * inference sees a single shape across all results in the array.
 * `JSON.stringify` drops `undefined` values, so the wire format is
 * unchanged.
 *
 * Phase 4.2 — non-mutating platforms parse: callers attach
 * `r.platformsParsed` (an Array) once at row arrival; this function
 * reads that first and only falls back to parsing `r.platforms`
 * itself when the caller didn't pre-parse. Either way, `r.platforms`
 * itself is never mutated.
 */

/** @param {unknown} value */
function parsePlatformsString(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * @param {object} r — search row from the storage layer.
 * @param {string} [matchQuality='match'] — relevance label propagated to clients.
 * @param {number} [distance] — Levenshtein distance (fuzzy results only).
 */
export function formatResult(r, matchQuality = 'match', distance = undefined) {
  // `platformsParsed` is the post-arrival cached parse (search.js
  // attaches it once per row to avoid re-parsing across cascade tiers).
  // Fall back to `r.platforms` for callers that didn't pre-parse.
  const platforms = r.platformsParsed ?? parsePlatformsString(r.platforms)
  return {
    title: r.title,
    framework: r.framework,
    rootSlug: r.root_slug,
    sourceType: r.source_type ?? null,
    sourceMetadata: r.source_metadata ?? null,
    kind: r.role_heading ?? r.role,
    abstract: r.abstract,
    path: r.path,
    platforms,
    declaration: r.declaration,
    urlDepth: r.url_depth ?? 0,
    isReleaseNotes: !!(r.is_release_notes),
    language: r.language ?? null,
    isDeprecated: r.is_deprecated ? true : undefined,
    isBeta: r.is_beta ? true : undefined,
    matchQuality,
    distance,
  }
}

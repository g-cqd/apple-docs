/**
 * Shared SQL surface for the four search variants in `./search.js`.
 *
 * The column projection and the filter predicate block are kept in one
 * place so a schema column addition or a new filter lands once instead of
 * four times, and so every variant returns the identical row shape the
 * cascade in commands/search.js depends on.
 */

import { encodeVersion } from '../../lib/version-encode.js'

// Column projection shared across the four search variants. Bundled here
// so a future schema column addition only has to land in one place.
export const RESULT_COLUMNS = `
  d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
  d.declaration_text as declaration, d.platforms_json as platforms,
  d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
  COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
  d.source_type as source_type, d.source_metadata as source_metadata,
  d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language
`

// Filter clauses appended to every variant after its specific MATCH/WHERE.
//
// Multi-source / year / track / deprecated push down to SQL so the
// over-fetch multiplier in search.js can stay at 3× — only `kind` and
// `platformFilters` remain JS-side.
export const FILTER_PREDICATES = `
  AND ($framework IS NULL OR d.framework = $framework)
  AND ($source_type IS NULL OR d.source_type = $source_type)
  AND ($sources_json IS NULL OR d.source_type IN (SELECT value FROM json_each($sources_json)))
  AND (
    $kind IS NULL
    OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
  )
  AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
  AND ($year IS NULL OR CAST(json_extract(d.source_metadata, '$.year') AS INTEGER) = $year)
  AND ($track_like IS NULL OR LOWER(COALESCE(json_extract(d.source_metadata, '$.track'), '')) LIKE $track_like)
  AND (
    $deprecated_mode = 'include'
    OR ($deprecated_mode = 'exclude' AND COALESCE(d.is_deprecated, 0) = 0)
    OR ($deprecated_mode = 'only'    AND COALESCE(d.is_deprecated, 0) = 1)
  )
  AND ($min_ios IS NULL OR d.min_ios_num IS NULL OR d.min_ios_num <= $min_ios)
  AND ($min_macos IS NULL OR d.min_macos_num IS NULL OR d.min_macos_num <= $min_macos)
  AND ($min_watchos IS NULL OR d.min_watchos_num IS NULL OR d.min_watchos_num <= $min_watchos)
  AND ($min_tvos IS NULL OR d.min_tvos_num IS NULL OR d.min_tvos_num <= $min_tvos)
  AND ($min_visionos IS NULL OR d.min_visionos_num IS NULL OR d.min_visionos_num <= $min_visionos)
`

export function buildFilterParams({
  framework = null, kind = null, language = null, sourceType = null,
  sources = null, year = null, track = null, deprecatedMode = 'include',
  minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null,
} = {}) {
  // Pack multi-source as a JSON array string for json_each().
  // null → no filter; single-element list → equivalent to $source_type.
  const sourcesJson = Array.isArray(sources) && sources.length > 0
    ? JSON.stringify(sources)
    : (sources instanceof Set && sources.size > 0
      ? JSON.stringify([...sources])
      : null)
  // Track filter is substring-matched (lowercase) so "graphics" matches
  // "Graphics & Games". $track_like has the `%...%` wrappers baked in.
  const trackLike = typeof track === 'string' && track.trim()
    ? `%${track.trim().toLowerCase()}%`
    : null
  // Deprecated mode is one of 'include' | 'exclude' | 'only'. The
  // FILTER_PREDICATES OR chain selects which branch applies — pass
  // through verbatim with a safe fallback.
  const deprecated = ['include', 'exclude', 'only'].includes(deprecatedMode)
    ? deprecatedMode
    : 'include'
  return {
    $framework: framework,
    $kind: kind,
    $language: language,
    $source_type: sourceType,
    $sources_json: sourcesJson,
    $year: typeof year === 'number' && Number.isFinite(year) ? year : null,
    $track_like: trackLike,
    $deprecated_mode: deprecated,
    // v15a: filter predicates compare numeric companions; encode the
    // user-supplied "17.4"-style strings to integers up front so SQLite
    // doesn't collate text. encodeVersion('') / null both → null which
    // the predicate treats as "no filter".
    $min_ios: encodeVersion(minIos),
    $min_macos: encodeVersion(minMacos),
    $min_watchos: encodeVersion(minWatchos),
    $min_tvos: encodeVersion(minTvos),
    $min_visionos: encodeVersion(minVisionos),
  }
}

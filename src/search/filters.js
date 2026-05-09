/**
 * Post-cascade JS filtering for search results. The SQL planner pushes
 * single-value filters (framework, source_type) down to the prepared
 * statement; everything multi-valued or fuzzy (kind taxonomy, platform
 * version comparisons, WWDC year/track, deprecated mode) runs here on
 * the over-fetched result set.
 *
 * Pulled out of commands/search.js as part of P2.6.
 */

const ROLE_KIND_FILTERS = new Set([
  'symbol', 'article', 'collection', 'overview', 'tutorial',
  'samplecode', 'sample_code', 'sample-project', 'sampleproject',
])

export function normalizeSourceFilter(source) {
  if (!source) return null
  const values = Array.isArray(source) ? source : String(source).split(',')
  const normalized = values
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  return normalized.length > 0 ? new Set(normalized) : null
}

export function normalizeDeprecatedFilter(value) {
  if (value == null || value === '') return 'include'
  const v = String(value).trim().toLowerCase()
  if (v === 'exclude' || v === 'only' || v === 'include') return v
  return 'include'
}

export function buildPlatformFilters(platform, explicit) {
  const filters = {
    minIos: explicit.minIos ?? null,
    minMacos: explicit.minMacos ?? null,
    minWatchos: explicit.minWatchos ?? null,
    minTvos: explicit.minTvos ?? null,
    minVisionos: explicit.minVisionos ?? null,
  }
  if (platform) {
    const key = {
      ios: 'minIos', macos: 'minMacos', watchos: 'minWatchos',
      tvos: 'minTvos', visionos: 'minVisionos',
    }[platform.toLowerCase()]
    if (key && !filters[key]) filters[key] = '0'
  }
  return filters
}

export function matchesSearchFilters(row, filters) {
  return matchesSourceFilter(row, filters.sourceTypes)
    && matchesFrameworkFilter(row, filters.frameworks)
    && matchesKindFilter(row, filters.kind)
    && matchesLanguageFilter(row, filters.language)
    && matchesPlatformFilters(row, filters.platformFilters)
    && matchesMetadataFilters(row, filters.year, filters.track)
    && matchesDeprecatedFilter(row, filters.deprecated)
}

function matchesSourceFilter(row, sourceTypes) {
  if (!sourceTypes) return true
  const sourceType = String(row?.source_type ?? row?.sourceType ?? '').toLowerCase()
  return sourceTypes.has(sourceType)
}

function matchesDeprecatedFilter(row, mode) {
  if (!mode || mode === 'include') return true
  const deprecated = !!(row?.is_deprecated ?? row?.isDeprecated)
  if (mode === 'exclude') return !deprecated
  if (mode === 'only') return deprecated
  return true
}

function matchesFrameworkFilter(row, frameworks) {
  const candidates = (frameworks ?? []).filter(Boolean).map(normalizeFilterValue)
  if (candidates.length === 0) return true
  const rowValues = [
    normalizeFilterValue(row?.root_slug ?? row?.rootSlug),
    normalizeFilterValue(row?.framework),
  ].filter(Boolean)
  return rowValues.some(value => candidates.includes(value))
}

function matchesKindFilter(row, kind) {
  if (!kind) return true
  const target = normalizeFilterValue(kind)
  if (!target) return true

  const displayedKind = normalizeFilterValue(row?.role_heading ?? row?.roleHeading)
  // Heuristic: "Article" / "Sample Code" arrives in the original case;
  // those match `role_heading`. lowercase-y values like `symbol` / `article`
  // match the role / doc_kind / kind columns.
  const looksLikeDisplayedKind = String(kind) !== String(kind).toLowerCase()
  if (looksLikeDisplayedKind) return displayedKind === target

  const roleCandidates = [
    row?.role,
    row?.doc_kind,
    row?.docKind,
    row?.kind,
  ].map(normalizeFilterValue).filter(Boolean)

  if (ROLE_KIND_FILTERS.has(target)) return roleCandidates.includes(target)
  return displayedKind === target
}

function matchesLanguageFilter(row, language) {
  if (!language) return true
  const normalizedLanguage = normalizeFilterValue(language)
  const value = normalizeFilterValue(row?.language)
  return !value || value === normalizedLanguage || value === 'both'
}

function matchesPlatformFilters(row, platformFilters) {
  const platforms = parsePlatforms(row?.platforms)
  return [
    ['minIos', 'ios', row?.min_ios ?? row?.minIos],
    ['minMacos', 'macos', row?.min_macos ?? row?.minMacos],
    ['minWatchos', 'watchos', row?.min_watchos ?? row?.minWatchos],
    ['minTvos', 'tvos', row?.min_tvos ?? row?.minTvos],
    ['minVisionos', 'visionos', row?.min_visionos ?? row?.minVisionos],
  ].every(([filterKey, platformKey, actual]) =>
    matchesPlatformVersion(actual ?? platforms?.[platformKey] ?? null, platformFilters[filterKey], {
      platformKey,
      platforms,
    }),
  )
}

function matchesPlatformVersion(actual, requested, opts = {}) {
  if (!requested) return true
  if (requested === '0') {
    if (actual) return true
    const explicitPlatforms = opts.platforms ? Object.keys(opts.platforms) : []
    if (explicitPlatforms.length === 0) return true
    return explicitPlatforms.includes(opts.platformKey)
  }
  if (!actual) return true
  return compareVersions(actual, requested) <= 0
}

function matchesMetadataFilters(row, year, track) {
  if (!year && !track) return true
  let metadata = null
  try {
    metadata = row?.source_metadata ?? row?.sourceMetadata
    metadata = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
  } catch {
    metadata = null
  }
  if (!metadata) return false
  if (year && metadata.year !== year) return false
  if (track) {
    const metadataTrack = normalizeFilterValue(metadata.track)
    if (!metadataTrack || !metadataTrack.includes(normalizeFilterValue(track))) return false
  }
  return true
}

function normalizeFilterValue(value) {
  return String(value ?? '').trim().toLowerCase()
}

function compareVersions(left, right) {
  const leftParts = parseVersionParts(left)
  const rightParts = parseVersionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let i = 0; i < length; i++) {
    const leftPart = leftParts[i] ?? 0
    const rightPart = rightParts[i] ?? 0
    if (leftPart !== rightPart) return leftPart - rightPart
  }
  return 0
}

function parseVersionParts(version) {
  return String(version ?? '')
    .match(/\d+/g)
    ?.map(part => Number.parseInt(part, 10))
    .filter(Number.isFinite) ?? []
}

function parsePlatforms(platforms) {
  if (!platforms) return null
  if (typeof platforms === 'string') {
    try { return JSON.parse(platforms) } catch { return null }
  }
  return typeof platforms === 'object' ? platforms : null
}

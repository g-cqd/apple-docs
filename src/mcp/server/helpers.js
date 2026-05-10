// Shared helpers for the MCP tool / resource handlers.

import { coerceSection } from '../../content/coercion.js'
import { MIN_PAGINATED_MAX_CHARS } from '../pagination.js'

/**
 * Apply the section coercion to every entry. The DB layer accepts both
 * camelCase and snake_case, but tools receive the row shape directly so
 * this is the single boundary that normalises before serialisation.
 */
export function sanitizeDocumentPayload(payload) {
  if (!Array.isArray(payload?.sections) || payload.sections.length === 0) return payload
  return {
    ...payload,
    sections: payload.sections.map(section => coerceSection(section)),
  }
}

export function validatePaginationArgs(args) {
  if (args.page != null && args.maxChars == null) {
    throw new Error('The page parameter requires maxChars.')
  }
}

/**
 * Resource URIs (apple-docs://framework/swiftui?maxChars=4096&page=2)
 * encode pagination as query params. Parse + validate them with the same
 * minimum-budget rule as the tool args.
 */
export function parseResourcePagination(uri) {
  const maxCharsValue = uri.searchParams.get('maxChars')
  const pageValue = uri.searchParams.get('page')
  const maxChars = maxCharsValue == null ? null : Number.parseInt(maxCharsValue, 10)
  const page = pageValue == null ? 1 : Number.parseInt(pageValue, 10)

  if (Number.isNaN(maxChars)) {
    throw new Error('Invalid maxChars query parameter.')
  }
  if (Number.isNaN(page) || page < 1) {
    throw new Error('Invalid page query parameter.')
  }
  if (pageValue != null && maxCharsValue == null) {
    throw new Error('The page query parameter requires maxChars.')
  }
  if (maxChars != null && maxChars < MIN_PAGINATED_MAX_CHARS) {
    throw new Error(`maxChars must be at least ${MIN_PAGINATED_MAX_CHARS}.`)
  }

  return { maxChars, page }
}

export function compactSearchHit(hit, opts = {}) {
  const { compact = false } = opts
  const result = {
    title: hit?.title ?? null,
    framework: hit?.framework ?? null,
    rootSlug: hit?.rootSlug ?? null,
    kind: hit?.kind ?? null,
    path: hit?.path ?? null,
    matchQuality: hit?.matchQuality ?? null,
  }

  if (!compact) {
    result.sourceType = hit?.sourceType ?? null
    result.sourceMetadata = hit?.sourceMetadata ?? null
    result.abstract = hit?.abstract ?? null
    result.platforms = hit?.platforms ?? []
    result.declaration = hit?.declaration ?? null
    result.urlDepth = hit?.urlDepth ?? 0
    result.isReleaseNotes = hit?.isReleaseNotes ?? false
    result.language = hit?.language ?? null
    result.snippet = hit?.snippet ?? null
    result.relatedCount = hit?.relatedCount ?? null
    if (hit?.isDeprecated) result.isDeprecated = true
    if (hit?.isBeta) result.isBeta = true
  }

  return result
}

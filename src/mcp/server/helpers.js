// Shared helpers for the MCP tool / resource handlers.

import { coerceSection } from '../../content/coercion.js'
import { ValidationError } from '../../lib/errors.js'
import { MIN_PAGINATED_MAX_CHARS } from '../pagination.js'

/**
 * Apply the section coercion to every entry. The DB layer accepts both
 * camelCase and snake_case, but tools receive the row shape directly so
 * this is the single boundary that normalises before serialisation.
 */
/** @param {Record<string, any>} payload */
export function sanitizeDocumentPayload(payload) {
  if (!Array.isArray(payload?.sections) || payload.sections.length === 0) return payload
  return {
    ...payload,
    sections: payload.sections.map((/** @type {any} */ section) => coerceSection(section)),
  }
}

/** @param {Record<string, any>} args */
export function validatePaginationArgs(args) {
  if (args.page != null && args.maxChars == null) {
    throw new ValidationError('The page parameter requires maxChars.', { field: 'page' })
  }
}

/**
 * Resource URIs (apple-docs://framework/swiftui?maxChars=4096&page=2)
 * encode pagination as query params. Parse + validate them with the same
 * minimum-budget rule as the tool args.
 */
/** @param {URL} uri */
export function parseResourcePagination(uri) {
  const maxCharsValue = uri.searchParams.get('maxChars')
  const pageValue = uri.searchParams.get('page')
  const maxChars = maxCharsValue == null ? null : Number.parseInt(maxCharsValue, 10)
  const page = pageValue == null ? 1 : Number.parseInt(pageValue, 10)

  if (Number.isNaN(maxChars)) {
    throw new ValidationError('Invalid maxChars query parameter.', { field: 'maxChars' })
  }
  if (Number.isNaN(page) || page < 1) {
    throw new ValidationError('Invalid page query parameter.', { field: 'page' })
  }
  if (pageValue != null && maxCharsValue == null) {
    throw new ValidationError('The page query parameter requires maxChars.', { field: 'page' })
  }
  if (maxChars != null && maxChars < MIN_PAGINATED_MAX_CHARS) {
    throw new ValidationError(`maxChars must be at least ${MIN_PAGINATED_MAX_CHARS}.`, { field: 'maxChars', value: maxChars })
  }

  return { maxChars, page }
}

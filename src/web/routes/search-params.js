import {
  MAX_SEARCH_QUERY_CHARS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
} from '../../lib/limits.js'

const UNSIGNED_INTEGER = /^\d+$/
const YEAR = /^\d{4}$/

/**
 * @typedef {{ ok: true, limit: number, offset: number, year: number | null }
 *         | { ok: false, parameter: string, message: string }} SearchParamsResult
 */

/**
 * Validate the numeric and length-bounded parameters of `/api/search`.
 *
 * Malformed values are rejected rather than silently replaced by a default,
 * so a client sending `limit=abc` or `limit=-1` learns about the mistake
 * instead of getting an empty or unexpectedly sized result. A `limit` above
 * the cap is clamped, because larger values are a legitimate "as many as you
 * allow" request.
 *
 * @param {URLSearchParams} params
 * @returns {SearchParamsResult}
 */
export function parseSearchParams(params) {
  const query = params.get('q') ?? ''
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    return { ok: false, parameter: 'q', message: `q must be at most ${MAX_SEARCH_QUERY_CHARS} characters.` }
  }

  let limit = SEARCH_DEFAULT_LIMIT
  const rawLimit = params.get('limit')
  if (rawLimit !== null) {
    if (!UNSIGNED_INTEGER.test(rawLimit) || Number(rawLimit) < 1) {
      return { ok: false, parameter: 'limit', message: 'limit must be a positive integer.' }
    }
    limit = Math.min(Number(rawLimit), SEARCH_MAX_LIMIT)
  }

  let offset = 0
  const rawOffset = params.get('offset')
  if (rawOffset !== null) {
    if (!UNSIGNED_INTEGER.test(rawOffset) || Number(rawOffset) > SEARCH_MAX_OFFSET) {
      return { ok: false, parameter: 'offset', message: `offset must be an integer from 0 to ${SEARCH_MAX_OFFSET}.` }
    }
    offset = Number(rawOffset)
  }

  let year = null
  const rawYear = params.get('year')
  if (rawYear !== null && rawYear !== '') {
    if (!YEAR.test(rawYear)) {
      return { ok: false, parameter: 'year', message: 'year must be a four-digit year.' }
    }
    year = Number(rawYear)
  }

  return { ok: true, limit, offset, year }
}

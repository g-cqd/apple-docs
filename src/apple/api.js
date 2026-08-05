import {
  fetchWithRetry as _fetchWithRetry,
  checkResourceEtag,
} from '../lib/fetch-with-retry.js'
import { NotFoundError } from '../lib/errors.js'

// Resolved per call, not at module load: tests point APPLE_DOCS_API_BASE at
// a local server, and a module-load snapshot made that dependent on which
// test file imported this module first (full-suite runs then hit the real
// Apple API and flaked).
const TUTORIALS_BASE = () => process.env.APPLE_DOCS_API_BASE ?? 'https://developer.apple.com/tutorials/data'
const USER_AGENT = 'apple-docs-mcp/1.0'
const DEFAULT_TIMEOUT = Number.parseInt(process.env.APPLE_DOCS_TIMEOUT ?? '30000', 10)
const MAX_RETRIES = 3

/**
 * Resolve a canonical path to its full fetch URL.
 * Paths starting with 'design/' use the /tutorials/data/design/ base.
 * All others use /tutorials/data/documentation/.
 */
function resolveUrl(path) {
  if (path.startsWith('design/')) {
    return `${TUTORIALS_BASE()}/${path}.json`
  }
  return `${TUTORIALS_BASE()}/documentation/${path}.json`
}

const defaultOpts = {
  headers: { 'User-Agent': USER_AGENT },
  maxRetries: MAX_RETRIES,
  timeout: DEFAULT_TIMEOUT,
}

/**
 * Fetch an Apple documentation page JSON.
 * @param {string} path - Canonical doc path (e.g. 'swiftui/view' or 'design/human-interface-guidelines/accessibility')
 * @param {import('../lib/rate-limiter.js').RateLimiter} rateLimiter
 * @returns {Promise<{ json: object, etag: string|null, lastModified: string|null }>}
 */
export async function fetchDocPage(path, rateLimiter) {
  const { data, etag, lastModified } = await _fetchWithRetry(
    resolveUrl(path),
    rateLimiter,
    defaultOpts,
  )
  return { json: data, etag, lastModified }
}

/**
 * Check if a page has changed via HEAD request.
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkDocPage(path, etag, rateLimiter, lastModified = null) {
  return checkResourceEtag(resolveUrl(path), etag, rateLimiter, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: DEFAULT_TIMEOUT,
    lastModified,
  })
}

/**
 * Conditional GET: check-and-fetch in one request. Replaces the HEAD+GET
 * pair for modified pages — a 304 costs the same as the old HEAD, and a
 * 200 delivers the payload that would otherwise need a second round-trip.
 *
 * @param {string} path canonical doc path
 * @param {{ etag?: string|null, lastModified?: string|null }} previousState
 * @returns {Promise<
 *   { status: 'unchanged' } |
 *   { status: 'deleted' } |
 *   { status: 'modified', json: object, etag: string|null, lastModified: string|null } |
 *   { status: 'error', error: string }
 * >}
 */
export async function fetchDocPageIfChanged(path, previousState, rateLimiter) {
  const conditional = previousState?.etag
    ? { 'If-None-Match': previousState.etag }
    : previousState?.lastModified
      ? { 'If-Modified-Since': previousState.lastModified }
      : {}
  try {
    const result = await _fetchWithRetry(resolveUrl(path), rateLimiter, {
      ...defaultOpts,
      headers: { ...defaultOpts.headers, ...conditional },
      allowNotModified: true,
    })
    if (result.notModified) return { status: 'unchanged' }
    return { status: 'modified', json: result.data, etag: result.etag, lastModified: result.lastModified }
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'deleted' }
    return { status: 'error', error: error.message }
  }
}

/**
 * Conditional GET of a root's navigation index (`/tutorials/data/index/<slug>`).
 * The index lists every page under the root (path/title/type tree), so a
 * changed index both gates per-page checks and announces new pages.
 *
 * @returns {Promise<
 *   { status: 'unchanged' } |
 *   { status: 'missing' } |
 *   { status: 'modified', json: object, etag: string|null } |
 *   { status: 'error' }
 * >}
 */
export async function fetchRootIndex(slug, previousEtag, rateLimiter) {
  const url = `${TUTORIALS_BASE()}/index/${slug}`
  try {
    const result = await _fetchWithRetry(url, rateLimiter, {
      ...defaultOpts,
      headers: { ...defaultOpts.headers, ...(previousEtag ? { 'If-None-Match': previousEtag } : {}) },
      allowNotModified: true,
    })
    if (result.notModified) return { status: 'unchanged' }
    return { status: 'modified', json: result.data, etag: result.etag }
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'missing' }
    return { status: 'error' }
  }
}

/**
 * Fetch the technologies index to discover documentation roots.
 */
export async function fetchTechnologies(rateLimiter) {
  const url = `${TUTORIALS_BASE()}/documentation/technologies.json`
  const { data, etag, lastModified } = await _fetchWithRetry(url, rateLimiter, defaultOpts)
  return { json: data, etag, lastModified }
}

/**
 * Fetch a raw HTML page (e.g. App Store Review Guidelines).
 * @param {string} url - Full URL to fetch
 * @param {import('../lib/rate-limiter.js').RateLimiter} rateLimiter
 * @returns {Promise<{ html: string, etag: string|null, lastModified: string|null }>}
 */
export async function fetchHtmlPage(url, rateLimiter) {
  const { text, etag, lastModified } = await _fetchWithRetry(url, rateLimiter, {
    ...defaultOpts,
    parseAs: 'text',
  })
  return { html: text, etag, lastModified }
}

/**
 * Check if an HTML page has changed via HEAD request.
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkHtmlPage(url, etag, rateLimiter) {
  return checkResourceEtag(url, etag, rateLimiter, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: DEFAULT_TIMEOUT,
  })
}

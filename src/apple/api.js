import {
  fetchWithRetry as _fetchWithRetry,
  checkResourceEtag,
} from '../lib/fetch-with-retry.js'

const TUTORIALS_BASE = process.env.APPLE_DOCS_API_BASE ?? 'https://developer.apple.com/tutorials/data'
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
    return `${TUTORIALS_BASE}/${path}.json`
  }
  return `${TUTORIALS_BASE}/documentation/${path}.json`
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
export async function checkDocPage(path, etag, rateLimiter) {
  return checkResourceEtag(resolveUrl(path), etag, rateLimiter, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: DEFAULT_TIMEOUT,
  })
}

/**
 * Fetch the technologies index to discover documentation roots.
 */
export async function fetchTechnologies(rateLimiter) {
  const url = `${TUTORIALS_BASE}/documentation/technologies.json`
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

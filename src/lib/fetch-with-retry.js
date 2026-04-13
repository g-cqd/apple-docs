/**
 * Shared HTTP fetch + retry utilities.
 * Consolidated from src/apple/api.js and src/lib/github.js.
 */

/**
 * Simple promise-based delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Calculate retry delay from Retry-After header or exponential backoff.
 * @param {Response|null} res
 * @param {number} attempt - zero-based attempt index
 * @returns {number} delay in milliseconds
 */
function retryDelayMs(res, attempt) {
  const retryAfter = res?.headers?.get?.('retry-after')
  if (retryAfter != null) {
    const seconds = Number.parseInt(retryAfter, 10)
    if (!Number.isNaN(seconds)) return seconds * 1000
  }
  return Math.min(1000 * (2 ** attempt), 8000)
}

/**
 * Perform a fetch with automatic retry on retriable status codes or network errors.
 *
 * @param {string} url
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @param {{
 *   headers?: Record<string, string>,
 *   parseAs?: 'json'|'text',
 *   retryableStatuses?: number[],
 *   maxRetries?: number,
 *   timeout?: number,
 *   notFoundAs?: 'not-found'|'http-error',
 *   _attempt?: number,
 * }} [opts]
 * @returns {Promise<
 *   { data: unknown, etag: string|null, lastModified: string|null } |
 *   { text: string, etag: string|null, lastModified: string|null }
 * >}
 */
export async function fetchWithRetry(url, rateLimiter, opts = {}) {
  const {
    headers = {},
    parseAs = 'json',
    retryableStatuses = [408, 429, 500, 502, 503, 504],
    maxRetries = 3,
    timeout = 30000,
    notFoundAs = 'not-found',
    _attempt = 0,
  } = opts

  await rateLimiter.acquire()

  let res
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    if (_attempt < maxRetries) {
      await sleep(retryDelayMs(null, _attempt))
      return fetchWithRetry(url, rateLimiter, { ...opts, _attempt: _attempt + 1 })
    }
    throw error
  }

  if (retryableStatuses.includes(res.status) && _attempt < maxRetries) {
    await sleep(retryDelayMs(res, _attempt))
    return fetchWithRetry(url, rateLimiter, { ...opts, _attempt: _attempt + 1 })
  }

  if (res.status === 404 && notFoundAs === 'not-found') {
    throw Object.assign(new Error(`Not found: ${url}`), { status: 404 })
  }

  if (!res.ok) {
    throw Object.assign(
      new Error(`HTTP ${res.status} fetching ${url}`),
      { status: res.status },
    )
  }

  const etag = res.headers.get('etag')
  const lastModified = res.headers.get('last-modified')

  if (parseAs === 'text') {
    return { text: await res.text(), etag, lastModified }
  }

  return { data: await res.json(), etag, lastModified }
}

/**
 * Perform a HEAD request with If-None-Match to detect whether a resource has changed.
 *
 * @param {string} url
 * @param {string|null} previousEtag
 * @param {{ acquire(): Promise<void> }} rateLimiter
 * @param {{
 *   headers?: Record<string, string>,
 *   timeout?: number,
 * }} [opts]
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkResourceEtag(url, previousEtag, rateLimiter, opts = {}) {
  const { headers = {}, timeout = 30000 } = opts

  await rateLimiter.acquire()

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        ...headers,
        ...(previousEtag ? { 'If-None-Match': previousEtag } : {}),
      },
      signal: AbortSignal.timeout(timeout),
    })

    if (res.status === 304) return { status: 'unchanged' }
    if (res.status === 404) return { status: 'deleted' }
    if (res.ok) return { status: 'modified', etag: res.headers.get('etag') }
    return { status: 'error' }
  } catch {
    return { status: 'error' }
  }
}

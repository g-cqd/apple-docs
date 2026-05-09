/**
 * Shared HTTP fetch + retry utilities.
 * Consolidated from src/apple/api.js and src/lib/github.js.
 */

import { HttpError, NotFoundError } from './errors.js'

/**
 * Simple promise-based delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function acquireRateLimit(rateLimiter, url) {
  return rateLimiter.acquire(url)
}

/**
 * Calculate retry delay from Retry-After header or exponential backoff.
 * @param {Response|null} res
 * @param {number} attempt - zero-based attempt index
 * @param {number} jitterMs
 * @returns {number} delay in milliseconds
 */
function retryDelayMs(res, attempt, jitterMs) {
  const retryAfter = res?.headers?.get?.('retry-after')
  const baseDelay = Math.min(1000 * (2 ** attempt), 8000)
  let retryAfterDelay = 0
  if (retryAfter != null) {
    const seconds = Number.parseInt(retryAfter, 10)
    if (!Number.isNaN(seconds)) retryAfterDelay = seconds * 1000
  }
  const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0
  return Math.max(retryAfterDelay, baseDelay) + jitter
}

/** Combine an optional caller signal with the per-attempt timeout signal,
 *  so an abort from either source aborts the in-flight request. */
function combineSignals(callerSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeoutSignal])
  // Polyfill fallback (bun ≥ 1.1 has AbortSignal.any natively): tie the
  // two together with a controller that aborts when either does.
  const controller = new AbortController()
  const onAbort = (sig) => () => controller.abort(sig.reason)
  if (callerSignal.aborted) controller.abort(callerSignal.reason)
  else callerSignal.addEventListener('abort', onAbort(callerSignal), { once: true })
  if (timeoutSignal.aborted) controller.abort(timeoutSignal.reason)
  else timeoutSignal.addEventListener('abort', onAbort(timeoutSignal), { once: true })
  return controller.signal
}

/**
 * Perform a fetch with automatic retry on retriable status codes or network errors.
 *
 * P2.8: caller can pass `signal` to abort the request (and any pending
 * retry sleeps). An aborted request does NOT retry — propagation is the
 * point — so the caller's AbortError surfaces to the await site.
 *
 * @param {string} url
 * @param {{ acquire(url?: string, opts?: { signal?: AbortSignal }): Promise<void> }} rateLimiter
 * @param {{
 *   headers?: Record<string, string>,
 *   parseAs?: 'json'|'text',
 *   retryableStatuses?: number[],
 *   maxRetries?: number,
 *   timeout?: number,
 *   jitterMs?: number,
 *   notFoundAs?: 'not-found'|'http-error',
 *   signal?: AbortSignal,
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
    jitterMs = 250,
    notFoundAs = 'not-found',
    signal,
    _attempt = 0,
  } = opts

  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')
  await acquireRateLimit(rateLimiter, url)
  if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')

  let res
  try {
    res = await fetch(url, {
      headers,
      signal: combineSignals(signal, timeout),
    })
  } catch (error) {
    // Caller-initiated abort: surface as-is, never retry.
    if (signal?.aborted) throw signal.reason ?? error
    if (_attempt < maxRetries) {
      await sleep(retryDelayMs(null, _attempt, jitterMs))
      return fetchWithRetry(url, rateLimiter, { ...opts, _attempt: _attempt + 1 })
    }
    throw error
  }

  if (retryableStatuses.includes(res.status) && _attempt < maxRetries) {
    await sleep(retryDelayMs(res, _attempt, jitterMs))
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')
    return fetchWithRetry(url, rateLimiter, { ...opts, _attempt: _attempt + 1 })
  }

  if (res.status === 404 && notFoundAs === 'not-found') {
    throw new NotFoundError(url)
  }

  if (!res.ok) {
    throw new HttpError(res.status, url)
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
 * @param {{ acquire(url?: string): Promise<void> }} rateLimiter
 * @param {{
 *   headers?: Record<string, string>,
 *   timeout?: number,
 * }} [opts]
 * @returns {Promise<{ status: 'unchanged'|'modified'|'deleted'|'error', etag?: string }>}
 */
export async function checkResourceEtag(url, previousEtag, rateLimiter, opts = {}) {
  const { headers = {}, timeout = 30000 } = opts

  await acquireRateLimit(rateLimiter, url)

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

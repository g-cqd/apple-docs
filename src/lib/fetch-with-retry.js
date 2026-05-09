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
 * GitHub returns 403 + `x-ratelimit-remaining: 0` (and sometimes a body
 * mentioning "secondary rate limit") when the abuse detector trips. These
 * are recoverable with a backoff — distinct from a permanent 403 (e.g.,
 * private repo without auth).
 * @param {Response} res
 * @returns {boolean}
 */
export function isRecoverableForbidden(res) {
  if (res.status !== 403) return false
  const remaining = res.headers.get?.('x-ratelimit-remaining')
  if (remaining === '0') return true
  const retryAfter = res.headers.get?.('retry-after')
  if (retryAfter != null) return true
  return false
}

/**
 * Calculate retry delay. Honors Retry-After and GitHub's `x-ratelimit-reset`
 * (epoch seconds) over exponential backoff when either points further out.
 * @param {Response|null} res
 * @param {number} attempt - zero-based attempt index
 * @param {number} jitterMs
 * @returns {number} delay in milliseconds
 */
function retryDelayMs(res, attempt, jitterMs) {
  const baseDelay = Math.min(1000 * (2 ** attempt), 8000)
  let upstreamDelay = 0

  const retryAfter = res?.headers?.get?.('retry-after')
  if (retryAfter != null) {
    const seconds = Number.parseInt(retryAfter, 10)
    if (Number.isFinite(seconds) && seconds > 0) upstreamDelay = seconds * 1000
  }

  const reset = res?.headers?.get?.('x-ratelimit-reset')
  if (reset != null) {
    const resetEpoch = Number.parseInt(reset, 10)
    if (Number.isFinite(resetEpoch)) {
      const ms = resetEpoch * 1000 - Date.now()
      // Cap at 60s so a misconfigured server can't park us indefinitely;
      // the caller's maxRetries still bounds total work.
      if (ms > 0) upstreamDelay = Math.max(upstreamDelay, Math.min(ms, 60_000))
    }
  }

  const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0
  return Math.max(upstreamDelay, baseDelay) + jitter
}

/**
 * Classify a fetch() rejection as retryable (transient network) or terminal
 * (programmer error, invalid URL, scheme not supported). AbortError is
 * handled by the caller before reaching here.
 * @param {unknown} error
 * @returns {'retryable'|'terminal'}
 */
export function classifyFetchError(error) {
  if (!error || typeof error !== 'object') return 'retryable'
  // TypeError from fetch() with a `cause` is the standard wrapper for
  // underlying socket / DNS / TLS failures — those are retryable.
  // A bare TypeError (no cause) usually means an invalid URL or unsupported
  // protocol — that's terminal.
  if (error.name === 'TypeError' && error.cause == null) return 'terminal'
  return 'retryable'
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
    // Programmer errors (invalid URL, unsupported scheme) shouldn't burn
    // retries — surface immediately so the bug is visible.
    if (classifyFetchError(error) === 'terminal') throw error
    if (_attempt < maxRetries) {
      await sleep(retryDelayMs(null, _attempt, jitterMs))
      return fetchWithRetry(url, rateLimiter, { ...opts, _attempt: _attempt + 1 })
    }
    throw error
  }

  const retryable = retryableStatuses.includes(res.status) || isRecoverableForbidden(res)
  if (retryable && _attempt < maxRetries) {
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

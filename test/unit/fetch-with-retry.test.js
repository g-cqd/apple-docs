import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  checkResourceEtag,
  classifyFetchError,
  fetchWithRetry,
  isRecoverableForbidden,
} from '../../src/lib/fetch-with-retry.js'
import { HttpError, NotFoundError } from '../../src/lib/errors.js'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalRandom = Math.random

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

describe('fetch-with-retry', () => {
  let fetchCalls
  let limiterCalls
  let delays

  beforeEach(() => {
    fetchCalls = []
    limiterCalls = []
    delays = []
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    globalThis.setTimeout = originalSetTimeout
    Math.random = originalRandom
  })

  test('retries with retry-after jitter and passes the request URL to the limiter', async () => {
    const url = 'https://developer.apple.com/tutorials/data/documentation/swiftui.json'
    const limiter = {
      async acquire(nextUrl) {
        limiterCalls.push(nextUrl)
      },
    }

    let attempts = 0
    globalThis.fetch = async (nextUrl) => {
      fetchCalls.push(String(nextUrl))
      attempts += 1
      if (attempts === 1) {
        return new Response('', {
          status: 503,
          headers: { 'retry-after': '2' },
        })
      }
      return jsonResponse({ ok: true }, 200, { etag: '"etag-1"' })
    }

    globalThis.setTimeout = (fn, ms, ...args) => {
      delays.push(ms)
      fn(...args)
      return 0
    }
    Math.random = () => 0.4

    const result = await fetchWithRetry(url, limiter, {
      maxRetries: 1,
      jitterMs: 250,
    })

    expect(result.data).toEqual({ ok: true })
    expect(fetchCalls).toEqual([url, url])
    expect(limiterCalls).toEqual([url, url])
    expect(delays).toHaveLength(1)
    expect(delays[0]).toBe(2100)
  })

  test('checkResourceEtag passes the URL through to the limiter', async () => {
    const url = 'https://raw.githubusercontent.com/apple/swift/main/README.md'
    const limiter = {
      async acquire(nextUrl) {
        limiterCalls.push(nextUrl)
      },
    }

    globalThis.fetch = async (nextUrl, opts) => {
      fetchCalls.push({ url: String(nextUrl), method: opts?.method ?? 'GET' })
      return new Response('', { status: 304 })
    }

    const result = await checkResourceEtag(url, '"prior"', limiter)

    expect(result).toEqual({ status: 'unchanged' })
    expect(limiterCalls).toEqual([url])
    expect(fetchCalls).toEqual([{ url, method: 'HEAD' }])
  })

  test('remains compatible with plain limiters that ignore the URL argument', async () => {
    let calls = 0
    const limiter = {
      async acquire() {
        calls += 1
      },
    }

    globalThis.fetch = async () => jsonResponse({ ok: true })

    const result = await fetchWithRetry('https://developer.apple.com/test', limiter)

    expect(result.data).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  describe('retry classification (P4.14)', () => {
    test('classifyFetchError treats bare TypeError as terminal', () => {
      expect(classifyFetchError(new TypeError('Invalid URL'))).toBe('terminal')
    })

    test('classifyFetchError treats TypeError with a cause as retryable (network wrap)', () => {
      const wrapped = new TypeError('fetch failed')
      wrapped.cause = new Error('ECONNRESET')
      expect(classifyFetchError(wrapped)).toBe('retryable')
    })

    test('classifyFetchError defaults unknown errors to retryable', () => {
      expect(classifyFetchError(new Error('socket hang up'))).toBe('retryable')
      expect(classifyFetchError(null)).toBe('retryable')
    })

    test('isRecoverableForbidden detects GitHub secondary rate limit (403 + remaining=0)', () => {
      const res = new Response('', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      })
      expect(isRecoverableForbidden(res)).toBe(true)
    })

    test('isRecoverableForbidden detects 403 with retry-after', () => {
      const res = new Response('', {
        status: 403,
        headers: { 'retry-after': '30' },
      })
      expect(isRecoverableForbidden(res)).toBe(true)
    })

    test('isRecoverableForbidden rejects plain 403 (permanent forbidden)', () => {
      expect(isRecoverableForbidden(new Response('', { status: 403 }))).toBe(false)
    })

    test('terminal fetch errors (invalid URL) are not retried', async () => {
      const limiter = { async acquire() {} }
      let attempts = 0
      globalThis.fetch = async () => {
        attempts += 1
        throw new TypeError('Invalid URL')
      }
      await expect(
        fetchWithRetry('not-a-url', limiter, { maxRetries: 5, jitterMs: 0 }),
      ).rejects.toThrow('Invalid URL')
      expect(attempts).toBe(1)
    })

    test('GitHub 403 with x-ratelimit-remaining=0 is retried, then succeeds', async () => {
      const limiter = { async acquire() {} }
      let attempts = 0
      globalThis.fetch = async () => {
        attempts += 1
        if (attempts === 1) {
          return new Response('', {
            status: 403,
            headers: {
              'x-ratelimit-remaining': '0',
              'retry-after': '1',
            },
          })
        }
        return jsonResponse({ ok: true })
      }
      globalThis.setTimeout = (fn, _ms, ...args) => { fn(...args); return 0 }
      const out = await fetchWithRetry('https://api.github.com/repos/x/y', limiter, {
        maxRetries: 1,
        jitterMs: 0,
      })
      expect(out.data).toEqual({ ok: true })
      expect(attempts).toBe(2)
    })

    test('plain 403 surfaces as HttpError immediately (no retry)', async () => {
      const limiter = { async acquire() {} }
      let attempts = 0
      globalThis.fetch = async () => {
        attempts += 1
        return new Response('forbidden', { status: 403 })
      }
      await expect(
        fetchWithRetry('https://api.github.com/repos/private/repo', limiter, {
          maxRetries: 3,
          jitterMs: 0,
        }),
      ).rejects.toBeInstanceOf(HttpError)
      expect(attempts).toBe(1)
    })

    test('404 with notFoundAs=not-found throws NotFoundError', async () => {
      const limiter = { async acquire() {} }
      globalThis.fetch = async () => new Response('', { status: 404 })
      await expect(
        fetchWithRetry('https://api.github.com/repos/x/missing', limiter, {
          maxRetries: 0,
          jitterMs: 0,
        }),
      ).rejects.toBeInstanceOf(NotFoundError)
    })
  })

  describe('AbortSignal (P2.8)', () => {
    test('rejects immediately when the caller signal is already aborted', async () => {
      const limiter = { async acquire() {} }
      const controller = new AbortController()
      controller.abort(new Error('user-cancelled'))
      let fetched = 0
      globalThis.fetch = async () => { fetched += 1; return jsonResponse({}) }
      await expect(
        fetchWithRetry('https://example.test/x', limiter, { signal: controller.signal }),
      ).rejects.toThrow('user-cancelled')
      expect(fetched).toBe(0)
    })

    test('does not retry after an in-flight abort', async () => {
      const limiter = { async acquire() {} }
      const controller = new AbortController()
      let attempts = 0
      globalThis.fetch = async (_url, opts) => {
        attempts += 1
        // Trip the caller signal between attempts
        controller.abort(new Error('mid-flight'))
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      await expect(
        fetchWithRetry('https://example.test/x', limiter, { signal: controller.signal, maxRetries: 5, jitterMs: 0 }),
      ).rejects.toThrow('mid-flight')
      expect(attempts).toBe(1)
    })

    test('passes a combined signal that fires on caller abort', async () => {
      const limiter = { async acquire() {} }
      const controller = new AbortController()
      let observedSignal = null
      globalThis.fetch = async (_url, opts) => {
        observedSignal = opts?.signal
        return jsonResponse({ ok: true })
      }
      await fetchWithRetry('https://example.test/x', limiter, { signal: controller.signal })
      expect(observedSignal).toBeInstanceOf(AbortSignal)
      expect(observedSignal.aborted).toBe(false)
      controller.abort()
      // The combined signal should now report aborted.
      expect(observedSignal.aborted).toBe(true)
    })
  })
})

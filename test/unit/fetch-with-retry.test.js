import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkResourceEtag, fetchWithRetry } from '../../src/lib/fetch-with-retry.js'

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

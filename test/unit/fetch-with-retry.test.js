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
})

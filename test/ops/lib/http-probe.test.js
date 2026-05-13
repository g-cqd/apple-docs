import { describe, test, expect } from 'bun:test'
import { probe, probeBatch, formatProbeLine } from '../../../ops/lib/http-probe.js'

function makeFetcher(handler) {
  return (url, init) => {
    return Promise.resolve(handler(url, init))
  }
}

function jsonResp(status, body = '') {
  return {
    status,
    body: makeStream(body),
    text: () => Promise.resolve(body),
  }
}

function makeStream(text) {
  const bytes = new TextEncoder().encode(text)
  let cursor = 0
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) { controller.close(); return }
      controller.enqueue(bytes.subarray(cursor))
      cursor = bytes.length
    },
  })
}

describe('probe', () => {
  test('ok=true when status matches expectedStatus', async () => {
    const fetcher = makeFetcher(() => jsonResp(200, '{"ok":true}'))
    const r = await probe('http://x/healthz', { deps: { fetcher } })
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect(r.outcome).toBe('http')
    expect(r.body).toContain('"ok":true')
  })

  test('ok=false on status mismatch', async () => {
    const fetcher = makeFetcher(() => jsonResp(503))
    const r = await probe('http://x/healthz', { deps: { fetcher } })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(503)
  })

  test('returns outcome=network on a transport error', async () => {
    const fetcher = () => Promise.reject(new Error('ECONNREFUSED'))
    const r = await probe('http://x/healthz', { deps: { fetcher } })
    expect(r.ok).toBe(false)
    expect(r.outcome).toBe('network')
    expect(r.error).toBe('ECONNREFUSED')
    expect(r.status).toBeNull()
  })

  test('returns outcome=timeout when AbortController fires', async () => {
    // Fetcher rejects with an AbortError-shaped error if the signal fires.
    const fetcher = (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
    const r = await probe('http://x', { deadlineMs: 10, deps: { fetcher } })
    expect(r.outcome).toBe('timeout')
  })

  test('truncates response body above bodyMaxBytes', async () => {
    const big = 'x'.repeat(10_000)
    const fetcher = makeFetcher(() => jsonResp(200, big))
    const r = await probe('http://x', { bodyMaxBytes: 100, deps: { fetcher } })
    expect(r.body.length).toBeLessThan(big.length)
  })

  test('forwards method/headers/body to fetcher', async () => {
    let captured
    const fetcher = (url, init) => {
      captured = { url, init }
      return jsonResp(200, 'ok')
    }
    await probe('http://x', {
      method: 'POST',
      headers: { 'X-Test': 'y' },
      body: '{"hello":1}',
      deps: { fetcher },
    })
    expect(captured.init.method).toBe('POST')
    expect(captured.init.headers).toEqual({ 'X-Test': 'y' })
    expect(captured.init.body).toBe('{"hello":1}')
  })
})

describe('probeBatch', () => {
  test('aggregates pass/fail counts and preserves order', async () => {
    let i = 0
    const fetcher = () => jsonResp(i++ === 1 ? 503 : 200, 'ok')
    const out = await probeBatch([
      { url: 'http://a' },
      { url: 'http://b' },
      { url: 'http://c' },
    ], { fetcher })
    expect(out.total).toBe(3)
    expect(out.passed).toBe(2)
    expect(out.failed).toBe(1)
    expect(out.results[1].url).toBe('http://b')
    expect(out.results[1].ok).toBe(false)
  })

  test('invokes logger.say per probe with a formatted line', async () => {
    const calls = []
    const logger = { say: (m) => calls.push(m) }
    const fetcher = makeFetcher(() => jsonResp(200, ''))
    await probeBatch([{ url: 'http://x' }], { fetcher, logger })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('http://x')
  })
})

describe('formatProbeLine', () => {
  test('uses ✓ for ok results', () => {
    expect(formatProbeLine({ ok: true, status: 200, url: 'http://x', elapsedMs: 12 })).toContain('✓ http://x → 200')
  })
  test('uses ✗ + reason for failures', () => {
    expect(formatProbeLine({ ok: false, status: null, outcome: 'network', url: 'http://x', elapsedMs: 5, error: 'ECONNREFUSED' }))
      .toContain('✗ http://x → network')
  })
})

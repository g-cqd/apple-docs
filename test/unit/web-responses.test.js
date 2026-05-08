import { describe, test, expect } from 'bun:test'
import {
  MIME_TYPES,
  COMPRESSIBLE,
  jsonResponse,
  textResponse,
  notFoundResponse,
  matchesIfNoneMatch,
  finalizeResponse,
} from '../../src/web/responses.js'

const SITE_CONFIG = {
  baseUrl: 'http://localhost',
  siteName: 'apple-docs',
  buildDate: '2026-05-08',
  assetVersion: 'test',
  bundled: false,
}

function makeGzipCache() {
  const map = new Map()
  return {
    get: (k) => map.get(k),
    set: (k, v) => { map.set(k, v) },
    _size: () => map.size,
  }
}

describe('MIME_TYPES', () => {
  test('covers the file extensions the asset routes need', () => {
    expect(MIME_TYPES['.html']).toContain('text/html')
    expect(MIME_TYPES['.css']).toContain('text/css')
    expect(MIME_TYPES['.js']).toContain('text/javascript')
    expect(MIME_TYPES['.json']).toContain('application/json')
    expect(MIME_TYPES['.svg']).toContain('image/svg+xml')
    expect(MIME_TYPES['.zip']).toBe('application/zip')
  })
})

describe('jsonResponse', () => {
  test('emits JSON with the right Content-Type', async () => {
    const r = jsonResponse({ ok: true })
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(await r.json()).toEqual({ ok: true })
  })

  test('honours status and merges custom headers', () => {
    const r = jsonResponse({ err: 'no' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    expect(r.status).toBe(503)
    expect(r.headers.get('cache-control')).toBe('no-store')
  })

  test('hashable: true sets the internal x-apple-docs-hashable marker', () => {
    const r = jsonResponse({}, { hashable: true })
    expect(r.headers.get('x-apple-docs-hashable')).toBe('1')
  })
})

describe('textResponse', () => {
  test('defaults to text/plain', async () => {
    const r = textResponse('hello')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    expect(await r.text()).toBe('hello')
  })

  test('overrides Content-Type via opts', () => {
    const r = textResponse('<p>hi</p>', { contentType: 'text/html; charset=utf-8' })
    expect(r.headers.get('content-type')).toContain('text/html')
  })
})

describe('notFoundResponse', () => {
  test('renders 404 HTML', async () => {
    const r = notFoundResponse(SITE_CONFIG)
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('text/html')
    const body = await r.text()
    expect(body.length).toBeGreaterThan(0)
  })
})

describe('matchesIfNoneMatch', () => {
  test('null / undefined header → false', () => {
    expect(matchesIfNoneMatch(null, '"abc"')).toBe(false)
    expect(matchesIfNoneMatch(undefined, '"abc"')).toBe(false)
  })

  test('wildcard star matches anything', () => {
    expect(matchesIfNoneMatch('*', '"abc"')).toBe(true)
    expect(matchesIfNoneMatch(' * ', '"abc"')).toBe(true)
  })

  test('exact and list matches', () => {
    expect(matchesIfNoneMatch('"abc"', '"abc"')).toBe(true)
    expect(matchesIfNoneMatch('"x", "abc", "y"', '"abc"')).toBe(true)
    expect(matchesIfNoneMatch('"x", "y"', '"abc"')).toBe(false)
  })
})

describe('finalizeResponse', () => {
  test('non-hashable, no Accept-Encoding: passes through unchanged', async () => {
    const req = new Request('http://x/y')
    const upstream = jsonResponse({ a: 1 })
    const out = await finalizeResponse(req, upstream, { gzipCache: makeGzipCache() })
    expect(out.headers.get('content-encoding')).toBeNull()
    expect(out.headers.get('etag')).toBeNull()
    expect(await out.json()).toEqual({ a: 1 })
  })

  test('hashable: attaches a sha256 ETag and clears the internal marker', async () => {
    const req = new Request('http://x/y')
    const upstream = jsonResponse({ a: 1 }, { hashable: true })
    const out = await finalizeResponse(req, upstream, { gzipCache: makeGzipCache() })
    expect(out.headers.get('x-apple-docs-hashable')).toBeNull()
    const etag = out.headers.get('etag')
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/)
  })

  test('hashable + matching If-None-Match → 304 with empty body', async () => {
    const cache = makeGzipCache()
    const req1 = new Request('http://x/y')
    const upstream1 = jsonResponse({ a: 1 }, { hashable: true })
    const out1 = await finalizeResponse(req1, upstream1, { gzipCache: cache })
    const etag = out1.headers.get('etag')

    const upstream2 = jsonResponse({ a: 1 }, { hashable: true })
    const req2 = new Request('http://x/y', { headers: { 'if-none-match': etag } })
    const out2 = await finalizeResponse(req2, upstream2, { gzipCache: cache })
    expect(out2.status).toBe(304)
    expect(out2.headers.get('etag')).toBe(etag)
  })

  test('gzip path: compressible MIME + Accept-Encoding gzip → encoded body, cached on the gzipCache', async () => {
    const cache = makeGzipCache()
    const upstream = jsonResponse({ payload: 'x'.repeat(2048) }, { hashable: true })
    const req = new Request('http://x/y', { headers: { 'accept-encoding': 'gzip' } })
    const out = await finalizeResponse(req, upstream, { gzipCache: cache })
    expect(out.headers.get('content-encoding')).toBe('gzip')
    expect(cache._size()).toBe(1)

    // Second pass with same body should hit the cache (same etag → same key)
    const upstream2 = jsonResponse({ payload: 'x'.repeat(2048) }, { hashable: true })
    const req2 = new Request('http://x/y', { headers: { 'accept-encoding': 'gzip' } })
    const out2 = await finalizeResponse(req2, upstream2, { gzipCache: cache })
    expect(out2.headers.get('content-encoding')).toBe('gzip')
    expect(cache._size()).toBe(1)
  })

  test('non-compressible MIME ignores gzip even when Accept-Encoding asks for it', async () => {
    const upstream = new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
    const req = new Request('http://x/y', { headers: { 'accept-encoding': 'gzip' } })
    const out = await finalizeResponse(req, upstream, { gzipCache: makeGzipCache() })
    expect(out.headers.get('content-encoding')).toBeNull()
  })
})

describe('COMPRESSIBLE set', () => {
  test('contains the wire-friendly text MIME bases', () => {
    expect(COMPRESSIBLE.has('text/html')).toBe(true)
    expect(COMPRESSIBLE.has('text/css')).toBe(true)
    expect(COMPRESSIBLE.has('text/javascript')).toBe(true)
    expect(COMPRESSIBLE.has('application/json')).toBe(true)
    expect(COMPRESSIBLE.has('image/png')).toBe(false)
    expect(COMPRESSIBLE.has('font/ttf')).toBe(false)
  })
})

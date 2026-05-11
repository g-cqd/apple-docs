/**
 * P3 — `/api/fonts/subset` tests. Layered:
 *
 *   1. Pure canonicalisation (no I/O).
 *   2. cmap-cap (needs a font on disk; gated on SF-Pro presence).
 *   3. Worker pool / route round-trip (needs pyftsubset on PATH).
 *
 * The pyftsubset-gated tests skip with a clear message when Python +
 * fontTools aren't installed — the deploy host is expected to have them,
 * but `bun test` on a stock CI runner shouldn't fail on absence.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DocsDatabase } from '../../src/storage/database.js'
import { startDevServer } from '../../src/web/serve.js'
import {
  canonicalizePostBody,
  canonicalizeQuery,
  canonicalKeyString,
  CanonicalizeError,
  DEFAULT_FORMAT,
  MAX_CODEPOINTS_PER_REQUEST,
} from '../../src/web/lib/font-subset/canonicalize.js'
import { resolveFontPath } from '../../src/web/lib/font-subset/font-resolver.js'
import { getLegalCodepointSet, capAgainst, _clearCmapCache } from '../../src/web/lib/font-subset/cmap-cap.js'
import { createPyftsubsetPool } from '../../src/web/lib/font-subset/pyftsubset-pool.js'
import { sha256 } from '../../src/lib/hash.js'

const SF_PRO_PATH = join(homedir(), '.apple-docs', 'resources', 'fonts', 'extracted', 'sf-pro', 'SF-Pro.ttf')
const HAS_SF_PRO = existsSync(SF_PRO_PATH)
const HAS_PYFTSUBSET = (() => {
  try {
    const r = spawnSync('python3', ['-c', 'import fontTools.subset'], { stdio: 'ignore' })
    return r.status === 0
  } catch { return false }
})()

describe('canonicalize', () => {
  test('decimal codepoints (POST)', () => {
    const c = canonicalizePostBody({ font: 'sf-pro', codepoints: [66, 65, 67] })
    expect(c).toEqual({ font: 'sf-pro', codepoints: [65, 66, 67], format: 'woff2' })
  })

  test('mixed hex / U+ / decimal codepoints (GET)', () => {
    // URLSearchParams treats raw `+` as space; the constructor accepts a
    // map-like object so each value lands in a single param without
    // x-www-form-urlencoded re-decoding.
    const params = new URLSearchParams()
    params.set('font', 'sf-pro')
    params.set('codepoints', '65,0x42,U+0043')
    const c = canonicalizeQuery(params)
    expect(c.codepoints).toEqual([65, 66, 67])
  })

  test('ranges expand inclusively', () => {
    const c = canonicalizePostBody({ font: 'sf-pro', ranges: [[0x41, 0x43]] })
    expect(c.codepoints).toEqual([0x41, 0x42, 0x43])
  })

  test('characters with surrogate-pair emoji yield supplementary codepoints', () => {
    const c = canonicalizePostBody({ font: 'sf-pro', characters: 'A\u{1F600}B' })
    expect(c.codepoints).toEqual([0x41, 0x42, 0x1F600])
  })

  test('empty input rejected', () => {
    expect(() => canonicalizePostBody({ font: 'sf-pro' })).toThrow(CanonicalizeError)
    expect(() => canonicalizeQuery(new URLSearchParams('font=sf-pro'))).toThrow(CanonicalizeError)
  })

  test('format defaults to woff2', () => {
    const c = canonicalizePostBody({ font: 'sf-pro', codepoints: [65] })
    expect(c.format).toBe(DEFAULT_FORMAT)
  })

  test('format validation rejects unknown values', () => {
    expect(() => canonicalizePostBody({ font: 'sf-pro', codepoints: [65], format: 'eot' }))
      .toThrow(CanonicalizeError)
  })

  test('format ttf and otf accepted', () => {
    expect(canonicalizePostBody({ font: 'sf-pro', codepoints: [65], format: 'ttf' }).format).toBe('ttf')
    expect(canonicalizePostBody({ font: 'sf-pro', codepoints: [65], format: 'otf' }).format).toBe('otf')
  })

  test('codepoints + characters + ranges merge + dedup', () => {
    const c = canonicalizePostBody({
      font: 'sf-pro',
      codepoints: [65, 65, 0x42],
      characters: 'BC',
      ranges: [[0x44, 0x45]],
    })
    expect(c.codepoints).toEqual([0x41, 0x42, 0x43, 0x44, 0x45])
  })

  test('invalid font id rejected', () => {
    expect(() => canonicalizePostBody({ font: '../etc', codepoints: [65] })).toThrow(CanonicalizeError)
    expect(() => canonicalizePostBody({ font: 'SF-Pro', codepoints: [65] })).toThrow(CanonicalizeError)
  })

  test('codepoint out of Unicode range rejected', () => {
    expect(() => canonicalizePostBody({ font: 'sf-pro', codepoints: [0x110000] })).toThrow(CanonicalizeError)
  })

  test('oversize range rejected with 413', () => {
    let err
    try { canonicalizePostBody({ font: 'sf-pro', ranges: [[0, 0x10FFFF]] }) } catch (e) { err = e }
    expect(err).toBeInstanceOf(CanonicalizeError)
    expect(err.status).toBe(413)
  })

  test('GET range form U+0041-U+005A parses', () => {
    const params = new URLSearchParams()
    params.set('font', 'sf-pro')
    params.set('ranges', 'U+0041-U+0043')
    const c = canonicalizeQuery(params)
    expect(c.codepoints).toEqual([0x41, 0x42, 0x43])
  })
})

describe('canonical key parity (GET vs POST)', () => {
  // Property-style: across N synthetic cases, GET and POST that describe
  // the same set produce the same SHA. No fast-check dep available, so
  // hand-drive the loop.
  test('100 random sets — GET and POST produce identical SHAs', () => {
    let rng = 1
    const next = () => {
      // xorshift32 — deterministic + dependency-free
      rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5
      return (rng >>> 0) / 0xffffffff
    }
    for (let i = 0; i < 100; i++) {
      const n = 1 + Math.floor(next() * 16)
      const set = new Set()
      while (set.size < n) set.add(0x41 + Math.floor(next() * 200))
      const cps = [...set]
      // Build POST with shuffled order + dup
      const shuffled = [...cps, cps[0]].sort(() => next() - 0.5)
      const postCanon = canonicalizePostBody({ font: 'sf-pro', codepoints: shuffled })
      // Build GET with mixed encodings
      const tokens = cps.map((cp, idx) => {
        if (idx % 3 === 0) return String(cp)
        if (idx % 3 === 1) return `0x${cp.toString(16)}`
        return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
      })
      const params = new URLSearchParams()
      params.set('font', 'sf-pro')
      params.set('codepoints', tokens.join(','))
      const getCanon = canonicalizeQuery(params)
      expect(sha256(canonicalKeyString(postCanon))).toBe(sha256(canonicalKeyString(getCanon)))
    }
  })
})

describe('font-resolver', () => {
  test('returns null for unknown family', () => {
    expect(resolveFontPath('not-a-family', '/tmp')).toBe(null)
  })
  test('returns null when file is absent', () => {
    expect(resolveFontPath('sf-pro', '/tmp/__nope')).toBe(null)
  })
})

describe('cmap-cap', () => {
  test.skipIf(!HAS_SF_PRO)('every codepoint in legal set passes; outside fails', async () => {
    _clearCmapCache()
    const legal = await getLegalCodepointSet('sf-pro', SF_PRO_PATH)
    expect(legal.size).toBeGreaterThan(100)
    // Sample legal codepoints from the set.
    const sample = [...legal].slice(0, 50)
    const ok = capAgainst(legal, sample)
    expect(ok.ok).toBe(true)
    expect(ok.illegal).toEqual([])

    // A codepoint we are confident isn't in SF-Pro (a deep PUA-B value).
    const illegal = [0x10FFFD, 0x10FFFC]
    const bad = capAgainst(legal, illegal)
    expect(bad.ok).toBe(false)
    expect(bad.illegalCount).toBe(2)
  })

  test.skipIf(!HAS_SF_PRO)('illegal sample is capped at 20', async () => {
    _clearCmapCache()
    const legal = await getLegalCodepointSet('sf-pro', SF_PRO_PATH)
    const bad = []
    let cp = 0x10FFFF
    while (bad.length < 50) {
      if (!legal.has(cp)) bad.push(cp)
      cp--
    }
    const res = capAgainst(legal, bad)
    expect(res.illegal.length).toBeLessThanOrEqual(20)
    expect(res.illegalCount).toBe(50)
  })
})

describe('pyftsubset pool', () => {
  let pool
  let tempDir

  beforeAll(async () => {
    if (!HAS_PYFTSUBSET || !HAS_SF_PRO) return
    tempDir = await mkdtemp(join(tmpdir(), 'font-subset-pool-test-'))
    pool = createPyftsubsetPool({ size: 1, tempDir, logger: null })
    await pool.init()
  })

  afterAll(async () => {
    if (pool) await pool.close()
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('Latin A–Z round-trip yields valid woff2', async () => {
    const cps = []
    for (let cp = 0x41; cp <= 0x5A; cp++) cps.push(cp)
    const bytes = await pool.run({
      canonical: { font: 'sf-pro', codepoints: cps, format: 'woff2' },
      fontPath: SF_PRO_PATH,
    })
    expect(bytes.byteLength).toBeGreaterThan(0)
    // wOF2 magic
    expect(bytes[0]).toBe(0x77) // 'w'
    expect(bytes[1]).toBe(0x4f) // 'O'
    expect(bytes[2]).toBe(0x46) // 'F'
    expect(bytes[3]).toBe(0x32) // '2'
  }, 30_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('determinism: same input → identical bytes across two runs', async () => {
    const cps = [0x41, 0x42, 0x43]
    const a = await pool.run({
      canonical: { font: 'sf-pro', codepoints: cps, format: 'woff2' },
      fontPath: SF_PRO_PATH,
    })
    const b = await pool.run({
      canonical: { font: 'sf-pro', codepoints: cps, format: 'woff2' },
      fontPath: SF_PRO_PATH,
    })
    expect(sha256(a)).toBe(sha256(b))
  }, 30_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('ttf output preserves sfnt magic', async () => {
    const bytes = await pool.run({
      canonical: { font: 'sf-pro', codepoints: [0x41], format: 'ttf' },
      fontPath: SF_PRO_PATH,
    })
    // SFNT magic for TTF: 0x00010000 (or 'true', 'OTTO' for CFF). SF-Pro
    // is a TrueType variable font → 0x00010000.
    expect(bytes[0]).toBe(0x00)
    expect(bytes[1]).toBe(0x01)
    expect(bytes[2]).toBe(0x00)
    expect(bytes[3]).toBe(0x00)
  }, 30_000)
})

describe('route contract (/api/fonts/subset)', () => {
  let server
  let db
  let dataDir

  beforeAll(async () => {
    if (!HAS_PYFTSUBSET || !HAS_SF_PRO) return
    db = new DocsDatabase(':memory:')
    dataDir = await mkdtemp(join(tmpdir(), 'font-subset-route-test-'))
    // The route resolves the font under `${dataDir}/resources/fonts/extracted/sf-pro/SF-Pro.ttf`.
    // Symlink (well, copy) the real master into place.
    const familyDir = join(dataDir, 'resources', 'fonts', 'extracted', 'sf-pro')
    mkdirSync(familyDir, { recursive: true })
    const target = join(familyDir, 'SF-Pro.ttf')
    // Hardlink would be ideal — but a plain Bun.write copy is fine for a
    // ~25 MB file and avoids cross-fs link failures.
    const file = Bun.file(SF_PRO_PATH)
    await Bun.write(target, file)
    server = await startDevServer({ port: 0 }, {
      db,
      dataDir,
      logger: { info() {}, warn() {}, error() {} },
    })
  }, 30_000)

  afterAll(async () => {
    if (server) await server.close?.()
    if (db) db.close()
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  })

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('POST happy path returns 200 + woff2', async () => {
    const res = await fetch(`${server.url}/api/fonts/subset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font: 'sf-pro', codepoints: [65, 66, 67] }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('font/woff2')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBeGreaterThan(0)
    expect(body[0]).toBe(0x77)
  }, 30_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('GET happy path returns same bytes as POST', async () => {
    const postRes = await fetch(`${server.url}/api/fonts/subset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font: 'sf-pro', codepoints: [0x41, 0x42, 0x43] }),
    })
    expect(postRes.status).toBe(200)
    const postBody = new Uint8Array(await postRes.arrayBuffer())

    const getRes = await fetch(`${server.url}/api/fonts/subset?font=sf-pro&codepoints=${encodeURIComponent('U+0041,U+0042,U+0043')}`)
    expect(getRes.status).toBe(200)
    const getBody = new Uint8Array(await getRes.arrayBuffer())
    expect(sha256(getBody)).toBe(sha256(postBody))
    // ETag parity too — both layers cache against the same key.
    expect(getRes.headers.get('etag')).toBe(postRes.headers.get('etag'))
  }, 30_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('illegal codepoint returns 422 with illegal list', async () => {
    const res = await fetch(`${server.url}/api/fonts/subset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font: 'sf-pro', codepoints: [0x10FFFD] }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/not in the source font/)
    expect(Array.isArray(body.illegal)).toBe(true)
    expect(body.illegal[0]).toBe(0x10FFFD)
  }, 15_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('empty input returns 400', async () => {
    const res = await fetch(`${server.url}/api/fonts/subset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ font: 'sf-pro' }),
    })
    expect(res.status).toBe(400)
  })

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('format=ttf returns font/ttf', async () => {
    const res = await fetch(`${server.url}/api/fonts/subset?font=sf-pro&codepoints=65&format=ttf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('font/ttf')
  }, 30_000)

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('body > 256 KB returns 413', async () => {
    // Generate a 300 KB JSON body. The simplest way is a large characters
    // string — 150k chars at 2 bytes each.
    const filler = 'A'.repeat(300_000)
    const body = JSON.stringify({ font: 'sf-pro', characters: filler })
    const res = await fetch(`${server.url}/api/fonts/subset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(res.status).toBe(413)
  })

  test.skipIf(!HAS_PYFTSUBSET || !HAS_SF_PRO)('If-None-Match returns 304', async () => {
    // Warm the cache first.
    const first = await fetch(`${server.url}/api/fonts/subset?font=sf-pro&codepoints=88`)
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    const second = await fetch(`${server.url}/api/fonts/subset?font=sf-pro&codepoints=88`, {
      headers: { 'If-None-Match': etag },
    })
    expect(second.status).toBe(304)
  }, 30_000)
})

// Suppress unused-import lint if MAX_CODEPOINTS_PER_REQUEST isn't exercised
// in a particular run.
void MAX_CODEPOINTS_PER_REQUEST
void dirname

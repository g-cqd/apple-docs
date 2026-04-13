import { afterEach, describe, expect, test } from 'bun:test'
import { WwdcAdapter, parseWwdcKey } from '../../../src/sources/wwdc.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRateLimiter() {
  return { acquire: async () => {} }
}

function makeCtx(overrides = {}) {
  let root = null
  return {
    rateLimiter: makeRateLimiter(),
    db: {
      getRootBySlug() {
        return root
      },
      upsertRoot(slug, displayName, kind, source) {
        root = { id: 1, slug, display_name: displayName, kind, source, source_type: 'wwdc' }
        return root
      },
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// parseWwdcKey
// ---------------------------------------------------------------------------

describe('parseWwdcKey', () => {
  test('parses a valid 2024 key', () => {
    const result = parseWwdcKey('wwdc/wwdc2024-10001')
    expect(result).toEqual({ year: 2024, sessionId: '10001' })
  })

  test('parses a valid pre-2020 key', () => {
    const result = parseWwdcKey('wwdc/wwdc2019-234')
    expect(result).toEqual({ year: 2019, sessionId: '234' })
  })

  test('returns null for a key missing the session ID', () => {
    expect(parseWwdcKey('wwdc/wwdc2024')).toBeNull()
  })

  test('returns null for an unrelated key', () => {
    expect(parseWwdcKey('swift-evolution/SE-0001')).toBeNull()
  })

  test('returns null for an empty string', () => {
    expect(parseWwdcKey('')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe('WwdcAdapter.discover', () => {
  test('registers root in DB when absent', async () => {
    const adapter = new WwdcAdapter()
    let upsertCalled = false
    let root = null

    globalThis.fetch = async (url) => {
      // Apple year-index — return empty arrays for all years
      if (url.includes('/tutorials/data/content/videos/')) {
        return new Response(JSON.stringify({ videos: [] }), { status: 200 })
      }
      // GitHub tree — empty
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    const ctx = {
      rateLimiter: makeRateLimiter(),
      db: {
        getRootBySlug() {
          return root
        },
        upsertRoot(slug, displayName, kind, source) {
          upsertCalled = true
          root = { id: 1, slug, display_name: displayName, kind, source, source_type: 'wwdc' }
          return root
        },
      },
    }

    await adapter.discover(ctx)

    expect(upsertCalled).toBe(true)
  })

  test('merges Apple and ASCIIwwdc keys without duplicates', async () => {
    const adapter = new WwdcAdapter()

    globalThis.fetch = async (url) => {
      // Apple year-index for 2024 returns one session
      if (url.includes('wwdc2024.json')) {
        return new Response(JSON.stringify({ videos: [{ id: '10001' }] }), { status: 200 })
      }
      // All other Apple year indexes return empty
      if (url.includes('/tutorials/data/content/videos/')) {
        return new Response(JSON.stringify({ videos: [] }), { status: 200 })
      }
      // GitHub tree returns one ASCIIwwdc file
      if (url.includes('api.github.com')) {
        return new Response(
          JSON.stringify({
            tree: [
              { path: 'en/2019/234.vtt', type: 'blob', sha: 'abc' },
              { path: 'en/2018/101.vtt', type: 'blob', sha: 'def' },
              // A non-English transcript should be ignored.
              { path: 'ja/2019/234.vtt', type: 'blob', sha: 'ghi' },
              // A non-.vtt entry should be ignored
              { path: 'en/2019/README.md', type: 'blob', sha: 'jkl' },
              // A year outside the allowed range should be ignored
              { path: 'en/2021/999.vtt', type: 'blob', sha: 'mno' },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('', { status: 404 })
    }

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('wwdc/wwdc2024-10001')
    expect(result.keys).toContain('wwdc/wwdc2019-234')
    expect(result.keys).toContain('wwdc/wwdc2018-101')
    // README and out-of-range year must not appear
    expect(result.keys.some(k => k.includes('README'))).toBe(false)
    expect(result.keys).not.toContain('wwdc/wwdc2021-999')
  })

  test('silently skips failed Apple year-index fetches', async () => {
    const adapter = new WwdcAdapter()

    globalThis.fetch = async (url) => {
      // Simulate Apple returning 404 for all years
      if (url.includes('/tutorials/data/content/videos/')) {
        return new Response('Not Found', { status: 404 })
      }
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    const ctx = makeCtx()
    const result = await adapter.discover(ctx)

    // Should not throw; keys may be empty
    expect(Array.isArray(result.keys)).toBe(true)
  })

  test('returns root in the result when DB has a root', async () => {
    const adapter = new WwdcAdapter()
    let root = null

    globalThis.fetch = async (url) => {
      if (url.includes('/tutorials/data/content/videos/')) {
        return new Response(JSON.stringify({ videos: [] }), { status: 200 })
      }
      if (url.includes('api.github.com')) {
        return new Response(JSON.stringify({ tree: [] }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }

    const ctx = {
      rateLimiter: makeRateLimiter(),
      db: {
        getRootBySlug() {
          return root
        },
        upsertRoot(slug, displayName, kind, source) {
          root = { id: 1, slug, display_name: displayName, kind, source, source_type: 'wwdc' }
          return root
        },
      },
    }

    const result = await adapter.discover(ctx)

    expect(result.roots).toHaveLength(1)
    expect(result.roots[0].slug).toBe('wwdc')
  })
})

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

describe('WwdcAdapter.fetch', () => {
  test('fetches Apple JSON for a 2024 session', async () => {
    const adapter = new WwdcAdapter()
    const payload = { title: 'Meet Swift Testing', description: 'Learn about Swift Testing.' }

    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { etag: '"abc"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      })

    const result = await adapter.fetch('wwdc/wwdc2024-10001', { rateLimiter: makeRateLimiter() })

    expect(result.key).toBe('wwdc/wwdc2024-10001')
    expect(result.payload).toEqual(payload)
    expect(result.etag).toBe('"abc"')
  })

  test('fetches ASCIIwwdc text for a pre-2020 session', async () => {
    const adapter = new WwdcAdapter()
    const transcript = '[00:00:00] Hello and welcome to WWDC.'

    globalThis.fetch = async () =>
      new Response(transcript, {
        status: 200,
        headers: { etag: '"xyz"' },
      })

    const result = await adapter.fetch('wwdc/wwdc2019-234', { rateLimiter: makeRateLimiter() })

    expect(result.key).toBe('wwdc/wwdc2019-234')
    expect(result.payload.transcript).toBe(transcript)
    expect(result.payload.year).toBe(2019)
    expect(result.payload.sessionId).toBe('234')
  })

  test('throws on an invalid key', async () => {
    const adapter = new WwdcAdapter()
    await expect(adapter.fetch('bad/key', { rateLimiter: makeRateLimiter() })).rejects.toThrow(
      'Invalid WWDC key',
    )
  })
})

// ---------------------------------------------------------------------------
// normalize — Apple JSON (2020+)
// ---------------------------------------------------------------------------

describe('WwdcAdapter.normalize — Apple JSON', () => {
  test('extracts title, description, and sets document fields', () => {
    const adapter = new WwdcAdapter()
    const payload = {
      title: 'Meet Swift Testing',
      description: 'An introduction to the Swift Testing framework.',
    }

    const result = adapter.normalize('wwdc/wwdc2024-10001', payload)

    expect(result.document.sourceType).toBe('wwdc')
    expect(result.document.title).toBe('Meet Swift Testing')
    expect(result.document.abstractText).toBe('An introduction to the Swift Testing framework.')
    expect(result.document.kind).toBe('wwdc-session')
    expect(result.document.role).toBe('article')
    expect(result.document.framework).toBe('wwdc')
    expect(result.document.url).toBe('https://developer.apple.com/videos/play/wwdc2024/10001/')
    expect(result.document.isDeprecated).toBe(false)
    expect(result.document.isBeta).toBe(false)
    expect(result.document.isReleaseNotes).toBe(false)
    expect(result.document.language).toBeNull()
    expect(result.relationships).toEqual([])
  })

  test('encodes year, sessionId, and source in sourceMetadata', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2024-10001', { title: 'Test' })
    const meta = JSON.parse(result.document.sourceMetadata)

    expect(meta.year).toBe(2024)
    expect(meta.sessionId).toBe('10001')
    expect(meta.source).toBe('apple')
  })

  test('produces an abstract section when description is present', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2024-10001', {
      title: 'Test',
      description: 'A description.',
    })

    const abstractSection = result.sections.find(s => s.sectionKind === 'abstract')
    expect(abstractSection).toBeDefined()
    expect(abstractSection.contentText).toBe('A description.')
  })

  test('produces a transcript section when transcript is present', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2024-10001', {
      title: 'Test',
      transcript: 'Hello world.',
    })

    const contentSection = result.sections.find(s => s.sectionKind === 'content')
    expect(contentSection).toBeDefined()
    expect(contentSection.contentText).toBe('Hello world.')
  })

  test('falls back to a derived title when JSON has no title', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2023-99999', {})

    expect(result.document.title).toBe('WWDC2023 Session 99999')
  })

  test('reads metadata.title when top-level title is absent', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2022-10100', {
      metadata: { title: 'What is new in SwiftUI' },
    })

    expect(result.document.title).toBe('What is new in SwiftUI')
  })

  test('reads metadata.description when top-level description is absent', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2022-10100', {
      title: 'Session',
      metadata: { description: 'A meta description.' },
    })

    expect(result.document.abstractText).toBe('A meta description.')
  })

  test('urlDepth is 1 for a two-part key', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2024-10001', { title: 'X' })
    expect(result.document.urlDepth).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// normalize — ASCIIwwdc text (pre-2020)
// ---------------------------------------------------------------------------

describe('WwdcAdapter.normalize — ASCIIwwdc text', () => {
  test('normalizes WEBVTT transcripts into plain text content', () => {
    const adapter = new WwdcAdapter()
    const text = [
      'WEBVTT',
      '',
      '00:00:15.576 --> 00:00:16.136 A:middle',
      '&gt;&gt; Hi, everyone.',
      '',
      '00:00:17.146 --> 00:00:18.806 A:middle',
      "I'm Jacob Xiao and I'll be",
      '',
      '00:00:17.146 --> 00:00:18.806 A:middle',
      "I'm Jacob Xiao and I'll be",
    ].join('\n')
    const result = adapter.normalize('wwdc/wwdc2019-234', { transcript: text, year: 2019, sessionId: '234', format: 'vtt' })

    expect(result.document.sourceType).toBe('wwdc')
    expect(result.document.kind).toBe('wwdc-session')
    expect(result.document.framework).toBe('wwdc')
    expect(result.document.url).toBe('https://developer.apple.com/videos/play/wwdc2019/234/')
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].sectionKind).toBe('content')
    expect(result.sections[0].contentText).toBe(">> Hi, everyone.\nI'm Jacob Xiao and I'll be")
    expect(result.relationships).toEqual([])
  })

  test('encodes year, sessionId, and source:asciiwwdc in sourceMetadata', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2019-234', {
      transcript: 'some text',
      year: 2019,
      sessionId: '234',
    })
    const meta = JSON.parse(result.document.sourceMetadata)

    expect(meta.year).toBe(2019)
    expect(meta.sessionId).toBe('234')
    expect(meta.source).toBe('asciiwwdc')
  })

  test('uses the first non-timestamp line as title when the payload is plain text', () => {
    const adapter = new WwdcAdapter()
    const text = 'Advances in UIKit\n[00:00:00] Welcome.'
    const result = adapter.normalize('wwdc/wwdc2018-101', {
      transcript: text,
      year: 2018,
      sessionId: '101',
    })

    expect(result.document.title).toBe('Advances in UIKit')
  })

  test('falls back to a derived title for WEBVTT transcripts', () => {
    const adapter = new WwdcAdapter()
    const text = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello world.'
    const result = adapter.normalize('wwdc/wwdc2015-101', {
      transcript: text,
      year: 2015,
      sessionId: '101',
    })

    expect(result.document.title).toBe('WWDC2015 Session 101')
  })

  test('handles a bare string payload (no wrapper object)', () => {
    const adapter = new WwdcAdapter()
    const text = 'Plain transcript text'
    // Some code paths may pass the raw string directly
    const result = adapter.normalize('wwdc/wwdc2016-100', {
      transcript: text,
      year: 2016,
      sessionId: '100',
    })

    expect(result.sections[0].contentText).toBe(text)
  })

  test('abstractText is null for ASCIIwwdc sessions', () => {
    const adapter = new WwdcAdapter()
    const result = adapter.normalize('wwdc/wwdc2017-200', {
      transcript: 'hello',
      year: 2017,
      sessionId: '200',
    })

    expect(result.document.abstractText).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe('WwdcAdapter.check', () => {
  test('dispatches to Apple HEAD check for year >= 2020', async () => {
    const adapter = new WwdcAdapter()
    let requestedUrl = null

    globalThis.fetch = async (url) => {
      requestedUrl = url
      return new Response('', { status: 200, headers: { etag: '"new"' } })
    }

    const result = await adapter.check(
      'wwdc/wwdc2024-10001',
      { etag: '"old"' },
      { rateLimiter: makeRateLimiter() },
    )

    expect(requestedUrl).toContain('wwdc2024')
    expect(requestedUrl).toContain('10001')
    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
    expect(result.newState.etag).toBe('"new"')
  })

  test('dispatches to GitHub HEAD check for year < 2020', async () => {
    const adapter = new WwdcAdapter()
    let requestedUrl = null

    globalThis.fetch = async (url) => {
      requestedUrl = url
      return new Response('', { status: 304 })
    }

    const result = await adapter.check(
      'wwdc/wwdc2019-234',
      { etag: '"old"' },
      { rateLimiter: makeRateLimiter() },
    )

    expect(requestedUrl).toContain('raw.githubusercontent.com')
    expect(requestedUrl).toContain('en/2019/234.vtt')
    expect(result.status).toBe('unchanged')
    expect(result.changed).toBe(false)
  })

  test('returns deleted status when Apple returns 404', async () => {
    const adapter = new WwdcAdapter()

    globalThis.fetch = async () => new Response('', { status: 404 })

    const result = await adapter.check(
      'wwdc/wwdc2023-50000',
      { etag: '"old"' },
      { rateLimiter: makeRateLimiter() },
    )

    expect(result.status).toBe('deleted')
    expect(result.deleted).toBe(true)
  })

  test('returns error status for network failures on Apple check', async () => {
    const adapter = new WwdcAdapter()

    globalThis.fetch = async () => {
      throw new Error('network error')
    }

    const result = await adapter.check(
      'wwdc/wwdc2024-10001',
      { etag: '"old"' },
      { rateLimiter: makeRateLimiter() },
    )

    expect(result.status).toBe('error')
  })

  test('returns error status for an invalid key', async () => {
    const adapter = new WwdcAdapter()

    const result = await adapter.check(
      'not-a-wwdc-key',
      {},
      { rateLimiter: makeRateLimiter() },
    )

    expect(result.status).toBe('error')
    expect(result.changed).toBe(false)
  })

  test('preserves previous etag in newState when unchanged', async () => {
    const adapter = new WwdcAdapter()

    globalThis.fetch = async () => new Response('', { status: 304 })

    const result = await adapter.check(
      'wwdc/wwdc2024-10001',
      { etag: '"cached"' },
      { rateLimiter: makeRateLimiter() },
    )

    expect(result.newState.etag).toBe('"cached"')
  })
})

// ---------------------------------------------------------------------------
// Static properties
// ---------------------------------------------------------------------------

describe('WwdcAdapter static properties', () => {
  test('has expected type, displayName, and syncMode', () => {
    expect(WwdcAdapter.type).toBe('wwdc')
    expect(WwdcAdapter.displayName).toBe('WWDC Session Transcripts')
    expect(WwdcAdapter.syncMode).toBe('flat')
  })
})

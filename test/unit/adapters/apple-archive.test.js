import { afterEach, describe, test, expect } from 'bun:test'
import { AppleArchiveAdapter } from '../../../src/sources/apple-archive.js'
import { deriveFramework } from '../../../src/sources/apple-archive.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  let storedRoot = null
  return {
    rateLimiter: { acquire: async () => {} },
    db: {
      getRootBySlug() {
        return storedRoot
      },
      upsertRoot(slug, displayName, kind, source) {
        storedRoot = { slug, display_name: displayName, kind, source, source_type: 'apple-archive' }
        return storedRoot
      },
    },
    ...overrides,
  }
}

/** Minimal HTML fixture simulating an Apple Archive guide page. */
const ARCHIVE_HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head>
  <title>Programming with Objective-C</title>
  <meta name="description" content="Learn the fundamentals of Objective-C.">
</head>
<body>
  <div id="contents">
    <h1>Programming with Objective-C</h1>
    <p>Objective-C is the primary programming language you use when writing software for OS X and iOS.</p>
    <h2>Defining Classes</h2>
    <p>Classes in Objective-C are defined in two distinct files: a header and an implementation.</p>
    <h2>Working with Objects</h2>
    <p>Objects in Objective-C are created and managed on the heap.</p>
  </div>
</body>
</html>`

const ARCHIVE_LIBRARY_FIXTURE = `({
  columns: {
    name: 0,
    type: 2,
    url: 9,
    platform: 12
  },
  documents: [
    [
      "Programming with Objective-C",
      "TP40011210",
      3,
      "2014-01-01",
      0, 0, 0, 0, 0,
      "../documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction/Introduction.html#//apple_ref/doc/uid/TP40011210",
      0,
      "2014-01-01",
      "macOS"
    ],
    [
      "Key-Value Coding Programming Guide",
      "TP40001803",
      3,
      "2013-01-01",
      0, 0, 0, 0, 0,
      "../documentation/Cocoa/Conceptual/KeyValueCoding/index.html#//apple_ref/doc/uid/TP40001803",
      0,
      "2013-01-01",
      "macOS"
    ],
    [
      "Java for WebObjects Developers",
      "TP40001434",
      3,
      "2003-01-01",
      0, 0, 0, 0, 0,
      "../documentation/WebObjects/JavaForWODev/JavaForWODev.pdf",
      0,
      "2003-01-01",
      "macOS"
    ],
    [
      "What's New In QuickTime",
      "TP40000939",
      3,
      "2004-01-01",
      0, 0, 0, 0, 0,
      "../documentation/QuickTime/whatsnew.htm",
      0,
      "2004-01-01",
      "macOS"
    ],
    [
      "Legacy Sample",
      "DTS10000001",
      5,
      "2010-01-01",
      0, 0, 0, 0, 0,
      "../samplecode/LegacySample/Introduction/Intro.html#//apple_ref/doc/uid/DTS10000001",
      0,
      "2010-01-01",
      "macOS"
    ]
  ]
})`

const ARCHIVE_LIBRARY_SIBLING_HTML_FIXTURE = `({
  columns: {
    name: 0,
    type: 2,
    url: 9,
    platform: 12
  },
  documents: [
    [
      "Ownership Policy",
      "TP40001148",
      3,
      "2009-01-01",
      0, 0, 0, 0, 0,
      "../documentation/CoreFoundation/Conceptual/CFMemoryMgmt/Concepts/Ownership.html#//apple_ref/doc/uid/20001148-103029",
      0,
      "2009-01-01",
      "macOS"
    ],
    [
      "The Create Rule",
      "TP40001148",
      3,
      "2009-01-01",
      0, 0, 0, 0, 0,
      "../documentation/CoreFoundation/Conceptual/CFMemoryMgmt/Concepts/CreateRule.html#//apple_ref/doc/uid/20001148-103030",
      0,
      "2009-01-01",
      "macOS"
    ]
  ]
})`

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

describe('AppleArchiveAdapter.discover', () => {
  test('returns a non-empty list of curated archive keys', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(Array.isArray(result.keys)).toBe(true)
    expect(result.keys.length).toBeGreaterThan(0)
  })

  test('all keys are prefixed with apple-archive/', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    for (const key of result.keys) {
      expect(key.startsWith('apple-archive/')).toBe(true)
    }
  })

  test('keys are unique (no duplicate directory paths)', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)
    const unique = new Set(result.keys)

    expect(unique.size).toBe(result.keys.length)
  })

  test('includes well-known Objective-C programming guide key', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).toContain(
      'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction',
    )
  })

  test('includes the KeyValueCoding index key', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('apple-archive/documentation/Cocoa/Conceptual/KeyValueCoding')
  })

  test('includes reachable PDF guides from the archive catalog', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('apple-archive/documentation/WebObjects/JavaForWODev/JavaForWODev.pdf')
  })

  test('registers the root in the database when absent', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.roots).toHaveLength(1)
    expect(result.roots?.[0]?.slug).toBe('apple-archive')
    expect(result.roots?.[0]?.display_name).toBe('Apple Developer Archive')
  })

  test('does not register a duplicate root when one already exists', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    let upsertCallCount = 0
    const ctx = {
      rateLimiter: { acquire: async () => {} },
      db: {
        getRootBySlug() {
          return { slug: 'apple-archive', display_name: 'Apple Developer Archive' }
        },
        upsertRoot() {
          upsertCallCount++
        },
      },
    }

    await adapter.discover(ctx)

    expect(upsertCallCount).toBe(0)
  })

  test('filters non-guide entries out of the archive catalog', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys.some(key => key.includes('LegacySample'))).toBe(false)
  })

  test('filters known missing archive URLs out of the catalog', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).not.toContain('apple-archive/documentation/QuickTime')
    expect(result.keys).not.toContain('apple-archive/documentation/QuickTime/whatsnew.htm')
  })

  test('preserves distinct sibling html pages under the same guide directory', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_SIBLING_HTML_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('apple-archive/documentation/CoreFoundation/Conceptual/CFMemoryMgmt/Concepts/Ownership.html')
    expect(result.keys).toContain('apple-archive/documentation/CoreFoundation/Conceptual/CFMemoryMgmt/Concepts/CreateRule.html')
  })

  test('still strips redundant index or repeated basename html pages', async () => {
    globalThis.fetch = async () => new Response(ARCHIVE_LIBRARY_FIXTURE, { status: 200 })
    const adapter = new AppleArchiveAdapter()
    const ctx = makeCtx()

    const result = await adapter.discover(ctx)

    expect(result.keys).toContain('apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction')
    expect(result.keys).toContain('apple-archive/documentation/Cocoa/Conceptual/KeyValueCoding')
  })
})

// ---------------------------------------------------------------------------
// check() — always 'unchanged' for frozen content
// ---------------------------------------------------------------------------

describe('AppleArchiveAdapter.check', () => {
  test('always returns unchanged status', async () => {
    const adapter = new AppleArchiveAdapter()
    const result = await adapter.check('apple-archive/any/key', null, makeCtx())

    expect(result.status).toBe('unchanged')
  })

  test('always returns changed: false', async () => {
    const adapter = new AppleArchiveAdapter()
    const result = await adapter.check('apple-archive/any/key', { etag: '"old"' }, makeCtx())

    expect(result.changed).toBe(false)
  })

  test('does not make any network requests', async () => {
    const adapter = new AppleArchiveAdapter()
    let fetchCalled = false
    const ctx = {
      ...makeCtx(),
      rateLimiter: {
        acquire: async () => {
          fetchCalled = true
        },
      },
    }

    await adapter.check('apple-archive/documentation/Cocoa/Conceptual/CoreData', null, ctx)

    expect(fetchCalled).toBe(false)
  })

  test('returns unchanged regardless of previousState content', async () => {
    const adapter = new AppleArchiveAdapter()
    const states = [null, undefined, {}, { etag: '"abc"' }, { lastModified: 'Tue, 01 Jan 2020 00:00:00 GMT' }]

    for (const state of states) {
      const result = await adapter.check('apple-archive/any/key', state, makeCtx())
      expect(result.status).toBe('unchanged')
    }
  })
})

// ---------------------------------------------------------------------------
// normalize()
// ---------------------------------------------------------------------------

describe('AppleArchiveAdapter.normalize', () => {
  test('produces a valid normalized document from HTML fixture', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document).toBeDefined()
    expect(Array.isArray(result.sections)).toBe(true)
    expect(Array.isArray(result.relationships)).toBe(true)
  })

  test('sets sourceType to apple-archive', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.sourceType).toBe('apple-archive')
  })

  test('sets kind to archive-guide', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.kind).toBe('archive-guide')
  })

  test('extracts title from HTML', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.title).toBe('Programming with Objective-C')
  })

  test('sets the document key correctly', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.key).toBe(key)
  })

  test('derives the correct framework from the key', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.framework).toBe('cocoa')
  })

  test('sets abstractText from description meta tag', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.abstractText).toBe('Learn the fundamentals of Objective-C.')
  })

  test('produces content sections from h2 headings', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    const headings = result.sections.map(s => s.heading).filter(Boolean)
    expect(headings).toContain('Defining Classes')
    expect(headings).toContain('Working with Objects')
  })

  test('sets url pointing to the archive base', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    const result = adapter.normalize(key, ARCHIVE_HTML_FIXTURE)

    expect(result.document.url).toMatch(/^https:\/\/developer\.apple\.com\/library\/archive\//)
  })

  test('handles payload passed as non-string gracefully', () => {
    const adapter = new AppleArchiveAdapter()
    const key = 'apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction'

    expect(() => adapter.normalize(key, Buffer.from(ARCHIVE_HTML_FIXTURE))).not.toThrow()
  })

  test('creates a metadata-only document for PDF archive guides', () => {
    const adapter = new AppleArchiveAdapter()
    adapter._guideCatalog = new Map([[
      'apple-archive/documentation/WebObjects/JavaForWODev/JavaForWODev.pdf',
      {
        title: 'Java for WebObjects Developers',
        url: 'https://developer.apple.com/library/archive/documentation/WebObjects/JavaForWODev/JavaForWODev.pdf',
        format: 'pdf',
        sourceMetadata: JSON.stringify({ resourceType: 'Guides', archivePath: 'documentation/WebObjects/JavaForWODev/JavaForWODev.pdf', format: 'pdf' }),
      },
    ]])

    const result = adapter.normalize(
      'apple-archive/documentation/WebObjects/JavaForWODev/JavaForWODev.pdf',
      { format: 'pdf', title: 'Java for WebObjects Developers' },
    )

    expect(result.document.sourceType).toBe('apple-archive')
    expect(result.document.title).toBe('Java for WebObjects Developers')
    expect(result.document.abstractText).toContain('PDF')
    expect(result.sections[0].contentText).toContain('original document')
  })
})

// ---------------------------------------------------------------------------
// deriveFramework()
// ---------------------------------------------------------------------------

describe('deriveFramework', () => {
  test.each([
    ['apple-archive/documentation/Cocoa/Conceptual/ProgrammingWithObjectiveC/Introduction', 'cocoa'],
    ['apple-archive/documentation/General/Conceptual/DevPedia-CocoaCore/Accessibility', 'general'],
    ['apple-archive/documentation/CoreFoundation/Conceptual/CFDesignConcepts', 'corefoundation'],
    ['apple-archive/documentation/DeveloperTools/Conceptual/InstrumentsUserGuide', 'developertools'],
    ['apple-archive/documentation/UIKit/Conceptual/UIKitUICatalog/UIButton', 'uikit'],
    ['apple-archive/documentation/Security/Conceptual/keychainServConcepts', 'security'],
    ['apple-archive/documentation/GraphicsImaging/Conceptual/drawingwithquartz2d/Introduction', 'graphicsimaging'],
    ['apple-archive/documentation/AudioVideo/Conceptual/AVFoundationPG/Articles', 'audiovideo'],
  ])('derives "%s" from key', (key, expected) => {
    expect(deriveFramework(key)).toBe(expected)
  })

  test('returns null for keys without a framework segment', () => {
    expect(deriveFramework('apple-archive')).toBeNull()
    expect(deriveFramework('apple-archive/documentation')).toBeNull()
  })
})

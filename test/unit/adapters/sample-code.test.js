import { afterEach, describe, expect, test } from 'bun:test'
import { SampleCodeAdapter } from '../../../src/sources/sample-code.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Minimal DocC JSON fixture for a sample code page
// ---------------------------------------------------------------------------

const SAMPLE_DOCC_JSON = {
  metadata: {
    title: 'Food Truck: Building a SwiftUI Multiplatform App',
    role: 'sampleCode',
    roleHeading: 'Sample Code',
    modules: [{ name: 'SwiftUI' }],
    platforms: [
      { name: 'iOS', introducedAt: '16.0' },
      { name: 'macOS', introducedAt: '13.0' },
    ],
  },
  abstract: [
    { type: 'text', text: 'Create a single codebase and app target for Mac, iPhone, and iPad.' },
  ],
  primaryContentSections: [
    {
      kind: 'content',
      content: [
        { type: 'heading', text: 'Overview' },
        {
          type: 'paragraph',
          inlineContent: [{ type: 'text', text: 'Food Truck demonstrates SwiftUI multiplatform patterns.' }],
        },
      ],
    },
  ],
  topicSections: [],
  relationshipsSections: [],
  seeAlsoSections: [],
  references: {},
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SampleCodeAdapter', () => {
  describe('static properties', () => {
    test('type is sample-code', () => {
      expect(SampleCodeAdapter.type).toBe('sample-code')
    })

    test('displayName is set', () => {
      expect(SampleCodeAdapter.displayName).toBe('Apple Sample Code')
    })

    test('syncMode is flat', () => {
      expect(SampleCodeAdapter.syncMode).toBe('flat')
    })
  })

  describe('discover()', () => {
    test('returns keys prefixed with sample-code/', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = { db: null }
      const result = await adapter.discover(ctx)

      expect(Array.isArray(result.keys)).toBe(true)
      expect(result.keys.length).toBeGreaterThan(0)
      for (const key of result.keys) {
        expect(key.startsWith('sample-code/')).toBe(true)
      }
    })

    test('includes bootstrap sample paths when the corpus has no sample inventory yet', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = { db: null }
      const result = await adapter.discover(ctx)

      expect(result.keys).toContain('sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app')
      expect(result.keys).toContain('sample-code/swiftui/composing-swiftui-gestures')
      expect(result.keys).toContain('sample-code/uikit/implementing-modern-collection-views')
      expect(result.keys).toContain('sample-code/arkit/creating-a-multiuser-ar-experience')
    })

    test('includes at least 10 bootstrap sample paths', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = { db: null }
      const result = await adapter.discover(ctx)

      expect(result.keys.length).toBeGreaterThanOrEqual(10)
    })

    test('registers root in DB when absent', async () => {
      const adapter = new SampleCodeAdapter()
      let upsertedSlug = null
      let upsertedName = null

      const ctx = {
        db: {
          getRootBySlug: () => null,
          upsertRoot(slug, name) {
            upsertedSlug = slug
            upsertedName = name
            return { slug, name }
          },
        },
      }

      await adapter.discover(ctx)

      expect(upsertedSlug).toBe('sample-code')
      expect(upsertedName).toBe('Apple Sample Code')
    })

    test('does not call upsertRoot when root already exists', async () => {
      const adapter = new SampleCodeAdapter()
      let upsertCallCount = 0

      const ctx = {
        db: {
          getRootBySlug: () => ({ slug: 'sample-code', name: 'Apple Sample Code' }),
          upsertRoot() { upsertCallCount++ },
        },
      }

      await adapter.discover(ctx)

      expect(upsertCallCount).toBe(0)
    })

    test('includes roots array when DB root exists', async () => {
      const adapter = new SampleCodeAdapter()
      const mockRoot = { slug: 'sample-code', name: 'Apple Sample Code' }

      const ctx = {
        db: {
          getRootBySlug: () => mockRoot,
          upsertRoot() {},
        },
      }

      const result = await adapter.discover(ctx)

      expect(result.roots).toEqual([mockRoot])
    })

    test('supplements curated list with DB pages of role sampleCode', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = {
        db: {
          getRootBySlug: () => null,
          upsertRoot() {},
          getPagesByRole: (role) => role === 'sampleCode'
            ? [{ key: 'mapkit/find-nearby-points-of-interest' }]
            : [],
        },
      }

      const result = await adapter.discover(ctx)

      expect(result.keys).toContain('sample-code/mapkit/find-nearby-points-of-interest')
    })

    test('accepts DB sample pages returned with a path field', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = {
        db: {
          getRootBySlug: () => null,
          upsertRoot() {},
          getPagesByRole: () => [{ path: 'accelerate/adding-a-bokeh-effect-to-images' }],
        },
      }

      const result = await adapter.discover(ctx)

      expect(result.keys).toContain('sample-code/accelerate/adding-a-bokeh-effect-to-images')
    })

    test('does not duplicate keys from DB that already match curated list', async () => {
      const adapter = new SampleCodeAdapter()
      const ctx = {
        db: {
          getRootBySlug: () => null,
          upsertRoot() {},
          // Returns a page key that duplicates a curated path (without prefix)
          getPagesByRole: () => [{ key: 'swiftui/food-truck-building-a-swiftui-multiplatform-app' }],
        },
      }

      const result = await adapter.discover(ctx)

      const occurrences = result.keys.filter(
        k => k === 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
      )
      expect(occurrences).toHaveLength(1)
    })
  })

  describe('normalize()', () => {
    test('produces a valid document structure', () => {
      const adapter = new SampleCodeAdapter()
      const key = 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app'
      const result = adapter.normalize(key, SAMPLE_DOCC_JSON)

      expect(result.document).toBeDefined()
      expect(Array.isArray(result.sections)).toBe(true)
      expect(Array.isArray(result.relationships)).toBe(true)
    })

    test('document.key matches the input key', () => {
      const adapter = new SampleCodeAdapter()
      const key = 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app'
      const result = adapter.normalize(key, SAMPLE_DOCC_JSON)

      expect(result.document.key).toBe(key)
    })

    test('document.title comes from DocC metadata', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      expect(result.document.title).toBe('Food Truck: Building a SwiftUI Multiplatform App')
    })

    test('document.kind is overridden to sample-project', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      expect(result.document.kind).toBe('sample-project')
    })

    test('document.sourceType is sample-code', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      expect(result.document.sourceType).toBe('sample-code')
    })

    test('document.url points to developer.apple.com/documentation', () => {
      const adapter = new SampleCodeAdapter()
      const key = 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app'
      const result = adapter.normalize(key, SAMPLE_DOCC_JSON)

      expect(result.document.url).toBe(
        'https://developer.apple.com/documentation/swiftui/food-truck-building-a-swiftui-multiplatform-app',
      )
    })

    test('document.sourceMetadata contains sampleProject flag', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      const meta = JSON.parse(result.document.sourceMetadata)
      expect(meta.sampleProject).toBe(true)
    })

    test('document.sourceMetadata includes the framework', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      const meta = JSON.parse(result.document.sourceMetadata)
      expect(meta.frameworks).toContain('swiftui')
    })

    test('document.abstractText is populated from DocC abstract', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      expect(result.document.abstractText).toContain('Create a single codebase')
    })

    test('sections include abstract and discussion', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        SAMPLE_DOCC_JSON,
      )

      const kinds = result.sections.map(s => s.sectionKind)
      expect(kinds).toContain('abstract')
      expect(kinds).toContain('discussion')
    })

    test('handles minimal empty JSON without throwing', () => {
      const adapter = new SampleCodeAdapter()
      const result = adapter.normalize('sample-code/uikit/my-sample', {})

      expect(result.document.key).toBe('sample-code/uikit/my-sample')
      expect(result.document.kind).toBe('sample-project')
      expect(result.sections).toBeInstanceOf(Array)
      expect(result.relationships).toBeInstanceOf(Array)
    })
  })

  describe('framework derivation', () => {
    test('derives framework from first path segment after sample-code/', () => {
      const adapter = new SampleCodeAdapter()

      const cases = [
        ['sample-code/swiftui/food-truck', 'swiftui'],
        ['sample-code/uikit/modern-collection-views', 'uikit'],
        ['sample-code/arkit/multiuser-ar', 'arkit'],
        ['sample-code/realitykit/immersive-experience', 'realitykit'],
        ['sample-code/coredata/sync-local-store', 'coredata'],
        ['sample-code/widgetkit/building-widgets', 'widgetkit'],
        ['sample-code/appkit/great-mac-app', 'appkit'],
      ]

      for (const [key, expectedFramework] of cases) {
        const result = adapter.normalize(key, {})
        expect(result.document.framework).toBe(expectedFramework)
      }
    })
  })

  describe('check()', () => {
    test('returns unchanged status on 304', async () => {
      globalThis.fetch = async () => new Response('', {
        status: 304,
        headers: { etag: '"same-etag"' },
      })

      const adapter = new SampleCodeAdapter()
      const result = await adapter.check(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        { etag: '"same-etag"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('unchanged')
      expect(result.changed).toBe(false)
    })

    test('returns modified status on 200', async () => {
      globalThis.fetch = async () => new Response('', {
        status: 200,
        headers: { etag: '"new-etag"' },
      })

      const adapter = new SampleCodeAdapter()
      const result = await adapter.check(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        { etag: '"old-etag"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('modified')
      expect(result.changed).toBe(true)
    })

    test('returns deleted status on 404', async () => {
      globalThis.fetch = async () => new Response('', { status: 404 })

      const adapter = new SampleCodeAdapter()
      const result = await adapter.check(
        'sample-code/swiftui/removed-sample',
        { etag: '"abc"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('deleted')
      expect(result.deleted).toBe(true)
    })

    test('returns error status on network failure', async () => {
      globalThis.fetch = async () => { throw new Error('network down') }

      const adapter = new SampleCodeAdapter()
      const result = await adapter.check(
        'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        { etag: '"abc"' },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(result.status).toBe('error')
    })

    test('strips sample-code/ prefix when building the HEAD request URL', async () => {
      let capturedUrl = null
      globalThis.fetch = async (url) => {
        capturedUrl = url
        return new Response('', { status: 304 })
      }

      const adapter = new SampleCodeAdapter()
      await adapter.check(
        'sample-code/uikit/implementing-modern-collection-views',
        { etag: null },
        { rateLimiter: { acquire: async () => {} } },
      )

      expect(capturedUrl).toContain('/documentation/uikit/implementing-modern-collection-views')
      expect(capturedUrl).not.toContain('sample-code')
    })
  })
})

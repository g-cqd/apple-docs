import { afterEach, describe, expect, test } from 'bun:test'
import { GuidelinesAdapter } from '../../../src/sources/guidelines.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('GuidelinesAdapter', () => {
  test('discovers and registers the guidelines root', async () => {
    let root = null
    const adapter = new GuidelinesAdapter()
    const ctx = {
      db: {
        getRootBySlug() {
          return root
        },
        upsertRoot(slug, displayName, kind, source) {
          root = { slug, display_name: displayName, kind, source, source_type: 'guidelines' }
          return root
        },
      },
    }

    const result = await adapter.discover(ctx)

    expect(result.keys).toEqual(['app-store-review'])
    expect(result.roots?.[0]?.slug).toBe('app-store-review')
  })

  test('normalizes a parsed guideline section and exposes hierarchy references', () => {
    const adapter = new GuidelinesAdapter()
    const payload = {
      id: 'section-1',
      path: 'app-store-review/1.0',
      title: '1.0 - Intro',
      abstract: 'Intro abstract',
      markdown: 'Intro body',
      role: 'collection',
      roleHeading: 'Section',
      children: ['app-store-review/1.1'],
    }

    const normalized = adapter.normalize(payload.path, payload)
    const refs = adapter.extractReferences(payload.path, payload)

    expect(normalized.document.sourceType).toBe('guidelines')
    expect(normalized.document.title).toBe('1.0 - Intro')
    expect(refs).toEqual(['app-store-review/1.1'])
  })

  test('maps HTML HEAD errors into explicit adapter check statuses', async () => {
    globalThis.fetch = async () => {
      throw new Error('network down')
    }

    const adapter = new GuidelinesAdapter()
    const result = await adapter.check('app-store-review', { etag: '"old"' }, {
      rateLimiter: { acquire: async () => {} },
    })

    expect(result.status).toBe('error')
    expect(result.changed).toBe(false)
  })
})

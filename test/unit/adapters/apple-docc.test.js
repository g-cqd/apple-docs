import { afterEach, describe, expect, test } from 'bun:test'
import { AppleDoccAdapter } from '../../../src/sources/apple-docc.js'

const fixture = await Bun.file(new URL('../../fixtures/swiftui-view.json', import.meta.url)).json()
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('AppleDoccAdapter', () => {
  test('discovers apple-docc roots from the prepared catalog', async () => {
    const adapter = new AppleDoccAdapter()
    const ctx = {
      rootCatalogReady: true,
      db: {
        getRoots() {
          return [
            { slug: 'swiftui', source_type: 'apple-docc' },
            { slug: 'design', source_type: 'hig' },
          ]
        },
      },
    }

    const result = await adapter.discover(ctx)

    expect(result.keys).toEqual(['swiftui'])
    expect(result.roots).toHaveLength(1)
  })

  test('normalizes DocC payloads and extracts references', () => {
    const adapter = new AppleDoccAdapter()
    const normalized = adapter.normalize('swiftui/view', fixture)
    const refs = adapter.extractReferences('swiftui/view', fixture)

    expect(normalized.document.sourceType).toBe('apple-docc')
    expect(normalized.document.title).toBe('View')
    expect(normalized.sections.length).toBeGreaterThan(3)
    expect(refs.length).toBeGreaterThan(10)
  })

  test('maps HEAD results into adapter check statuses', async () => {
    globalThis.fetch = async () => new Response('', {
      status: 304,
      headers: { etag: '"same"' },
    })

    const adapter = new AppleDoccAdapter()
    const result = await adapter.check('swiftui/view', { etag: '"same"' }, {
      rateLimiter: { acquire: async () => {} },
    })

    expect(result.status).toBe('unchanged')
    expect(result.changed).toBe(false)
  })

  test('check returns modified status on 200', async () => {
    globalThis.fetch = async () => new Response('', {
      status: 200,
      headers: { etag: '"new-etag"' },
    })

    const adapter = new AppleDoccAdapter()
    const result = await adapter.check('swiftui/view', { etag: '"old"' }, {
      rateLimiter: { acquire: async () => {} },
    })

    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
  })

  test('check returns error status on network failure', async () => {
    globalThis.fetch = async () => { throw new Error('network down') }

    const adapter = new AppleDoccAdapter()
    const result = await adapter.check('swiftui/view', { etag: '"x"' }, {
      rateLimiter: { acquire: async () => {} },
    })

    expect(result.status).toBe('error')
    expect(result.changed).toBe(false)
  })

  test('normalize handles minimal/empty JSON', () => {
    const adapter = new AppleDoccAdapter()
    const result = adapter.normalize('test/empty', {})

    expect(result.document.key).toBe('test/empty')
    expect(result.sections).toBeInstanceOf(Array)
    expect(result.relationships).toBeInstanceOf(Array)
  })
})

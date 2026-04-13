import { afterEach, describe, expect, test } from 'bun:test'
import { HigAdapter } from '../../../src/sources/hig.js'

const fixture = await Bun.file(new URL('../../fixtures/swiftui-view.json', import.meta.url)).json()
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('HigAdapter', () => {
  test('discovers hig roots from the prepared catalog', async () => {
    const adapter = new HigAdapter()
    const ctx = {
      rootCatalogReady: true,
      db: {
        getRoots() {
          return [
            { slug: 'swiftui', seed_path: null, source_type: 'apple-docc' },
            { slug: 'design', seed_path: 'design/human-interface-guidelines', source_type: 'hig' },
          ]
        },
      },
    }

    const result = await adapter.discover(ctx)

    expect(result.keys).toEqual(['design/human-interface-guidelines'])
    expect(result.roots).toHaveLength(1)
  })

  test('reuses DocC normalization with the hig source type', () => {
    const adapter = new HigAdapter()
    const normalized = adapter.normalize('design/human-interface-guidelines/layout', fixture)

    expect(normalized.document.sourceType).toBe('hig')
    expect(normalized.document.url).toBe('https://developer.apple.com/design/human-interface-guidelines/layout')
  })

  test('maps modified HEAD responses into adapter check statuses', async () => {
    globalThis.fetch = async () => new Response('', {
      status: 200,
      headers: { etag: '"new"' },
    })

    const adapter = new HigAdapter()
    const result = await adapter.check('design/human-interface-guidelines/layout', { etag: '"old"' }, {
      rateLimiter: { acquire: async () => {} },
    })

    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
    expect(result.newState).toEqual({ etag: '"new"' })
  })
})

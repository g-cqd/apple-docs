import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'
import {
  CURATED_ARCHIVES,
  ExternalDoccAdapter,
  indexPathToKey,
  isDoccPayload,
} from '../../../src/sources/external-docc.js'

const TECH_URL = 'https://developer.apple.com/tutorials/data/documentation/technologies.json'
const realFetch = globalThis.fetch
const rateLimiter = { acquire: async () => {} }

/** Minimal Response-like for the canned fixtures fetchWithRetry consumes. */
function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'etag' ? '"abc"' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

/** Install a URL → body fixture map; anything unmapped 404s. */
function installFetch(map) {
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (Object.prototype.hasOwnProperty.call(map, u)) return jsonResponse(map[u])
    return jsonResponse({}, 404)
  }
}

function doccPage(title, refs = {}, topicIds = []) {
  return {
    schemaVersion: { major: 0, minor: 3, patch: 0 },
    identifier: { url: `doc://test/documentation/${title}` },
    kind: 'symbol',
    metadata: { title },
    topicSections: topicIds.length ? [{ identifiers: topicIds }] : [],
    references: refs,
  }
}

let db
let ctx
beforeEach(() => {
  db = new DocsDatabase(':memory:')
  ctx = { db, rateLimiter, logger: { info() {}, warn() {}, error() {}, debug() {} } }
})
afterEach(() => {
  db.close()
  globalThis.fetch = realFetch
})

describe('ExternalDoccAdapter helpers', () => {
  test('indexPathToKey strips the /documentation/ prefix and lowercases', () => {
    expect(indexPathToKey('/documentation/CareKit/OCKTask')).toBe('carekit/ocktask')
    expect(indexPathToKey('/documentation/docc/')).toBe('docc')
    expect(indexPathToKey('/tutorials/foo')).toBeNull()
    expect(indexPathToKey(null)).toBeNull()
  })

  test('isDoccPayload requires a schemaVersion object plus identifying fields', () => {
    expect(isDoccPayload(doccPage('CareKit'))).toBe(true)
    expect(isDoccPayload({ schemaVersion: { major: 0 }, kind: 'article' })).toBe(true)
    expect(isDoccPayload({})).toBe(false)
    expect(isDoccPayload({ schemaVersion: 'x', kind: 'symbol' })).toBe(false)
    expect(isDoccPayload(null)).toBe(false)
  })

  test('exposes the three curated archives', () => {
    expect(Object.keys(CURATED_ARCHIVES).sort()).toEqual(['carekit', 'docc', 'private-cloud-compute'])
    expect(CURATED_ARCHIVES.carekit.baseUrl).toBe('https://carekit-apple.github.io/CareKit')
  })
})

describe('ExternalDoccAdapter normalize / references', () => {
  test('normalize points the rendered URL at the upstream host, not Apple', () => {
    const adapter = new ExternalDoccAdapter()
    const result = adapter.normalize('carekit/ocktask', doccPage('OCKTask'))
    expect(result.document.url).toBe('https://carekit-apple.github.io/CareKit/documentation/carekit/ocktask')
    expect(result.document.sourceType).toBe('external-docc')
    expect(result.document.framework).toBe('carekit')
  })

  test('extractReferences keeps only same-archive links', () => {
    const adapter = new ExternalDoccAdapter()
    const json = doccPage('CareKit', {
      a: { url: '/documentation/carekit/ocktask' },
      b: { url: '/documentation/swiftui/view' },
    }, ['a', 'b'])
    expect(adapter.extractReferences('carekit', json)).toEqual(['carekit/ocktask'])
  })

  test('resolveArchive throws for an unknown slug', () => {
    const adapter = new ExternalDoccAdapter()
    expect(() => adapter.resolveArchive('unknown/page')).toThrow(/Unknown external-docc archive/)
  })

  test('fetch requests the archive data URL for the resolved key', async () => {
    const adapter = new ExternalDoccAdapter()
    const requested = []
    globalThis.fetch = async (url) => {
      requested.push(String(url))
      return jsonResponse(doccPage('DocC'))
    }
    const result = await adapter.fetch('docc/tutorial', ctx)
    expect(requested[0]).toBe('https://www.swift.org/data/documentation/docc/tutorial.json')
    expect(result.key).toBe('docc/tutorial')
    expect(result.payload.metadata.title).toBe('DocC')
  })
})

describe('ExternalDoccAdapter discover', () => {
  test('registers curated roots and enumerates keys via BFS when no index exists', async () => {
    // No index.json anywhere (404) → BFS from each archive root. CareKit links
    // one child; the others are single-page.
    installFetch({
      [TECH_URL]: { sections: [] },
      'https://carekit-apple.github.io/CareKit/data/documentation/carekit.json':
        doccPage('CareKit', { c: { url: '/documentation/carekit/ocktask' } }, ['c']),
      'https://carekit-apple.github.io/CareKit/data/documentation/carekit/ocktask.json':
        doccPage('OCKTask'),
      'https://security.apple.com/data/documentation/private-cloud-compute.json':
        doccPage('Private Cloud Compute'),
      'https://www.swift.org/data/documentation/docc.json': doccPage('DocC'),
    })

    const adapter = new ExternalDoccAdapter()
    const result = await adapter.discover(ctx)

    expect(result.keys.sort()).toEqual(['carekit', 'carekit/ocktask', 'docc', 'private-cloud-compute'])
    expect(result.roots.map(r => r.slug).sort()).toEqual(['carekit', 'docc', 'private-cloud-compute'])
    // Roots are persisted with the external-docc source type.
    expect(db.getRootBySlug('carekit').source_type).toBe('external-docc')
  })

  test('enumerates via index.json when the archive publishes one', async () => {
    installFetch({
      [TECH_URL]: { sections: [] },
      'https://www.swift.org/index/index.json': {
        interfaceLanguages: {
          swift: [{ path: '/documentation/docc', children: [
            { path: '/documentation/docc/tutorial' },
            { path: '/documentation/other/leak' }, // different archive — dropped
          ] }],
        },
      },
      // Curated siblings: single page, no index.
      'https://carekit-apple.github.io/CareKit/data/documentation/carekit.json': doccPage('CareKit'),
      'https://security.apple.com/data/documentation/private-cloud-compute.json': doccPage('PCC'),
    })

    const adapter = new ExternalDoccAdapter()
    const result = await adapter.discover(ctx)
    expect(result.keys).toContain('docc')
    expect(result.keys).toContain('docc/tutorial')
    expect(result.keys).not.toContain('other/leak')
  })

  test('detects a new DocC archive from technologies.json and rejects non-DocC links', async () => {
    installFetch({
      [TECH_URL]: {
        sections: [{ groups: [{ name: 'App Frameworks', technologies: [
          { title: 'FooKit', destination: { identifier: 'https://foo.example/documentation/fookit' } },
          { title: 'BarKit', destination: { identifier: 'https://github.com/BarKit' } }, // not DocC-shaped
          { title: 'BazKit', destination: { identifier: 'https://baz.example/documentation/bazkit' } }, // shaped but probe fails
        ] }] }],
      },
      // FooKit: probe + root resolve as DocC.
      'https://foo.example/data/documentation/fookit.json': doccPage('FooKit'),
      // BazKit: shaped URL but the data endpoint is not DocC JSON.
      'https://baz.example/data/documentation/bazkit.json': { not: 'docc' },
      // Curated siblings, single page.
      'https://carekit-apple.github.io/CareKit/data/documentation/carekit.json': doccPage('CareKit'),
      'https://security.apple.com/data/documentation/private-cloud-compute.json': doccPage('PCC'),
      'https://www.swift.org/data/documentation/docc.json': doccPage('DocC'),
    })

    const adapter = new ExternalDoccAdapter()
    const result = await adapter.discover(ctx)

    expect(adapter.archives.fookit).toEqual({
      displayName: 'FooKit', kind: 'framework', baseUrl: 'https://foo.example',
    })
    expect(adapter.archives.bazkit).toBeUndefined()
    expect(adapter.archives.barkit).toBeUndefined()
    expect(result.keys).toContain('fookit')
    expect(db.getRootBySlug('fookit').display_name).toBe('FooKit')
  })

  test('does not clobber a slug already owned by another source', async () => {
    db.upsertRoot('docc', 'Apple DocC', 'framework', 'apple-index', null, 'apple-docc')
    installFetch({
      [TECH_URL]: { sections: [] },
      'https://carekit-apple.github.io/CareKit/data/documentation/carekit.json': doccPage('CareKit'),
      'https://security.apple.com/data/documentation/private-cloud-compute.json': doccPage('PCC'),
      'https://www.swift.org/data/documentation/docc.json': doccPage('DocC'),
    })

    const adapter = new ExternalDoccAdapter()
    const result = await adapter.discover(ctx)

    // The pre-existing apple-docc 'docc' root is left untouched.
    expect(db.getRootBySlug('docc').source_type).toBe('apple-docc')
    expect(result.roots.map(r => r.slug)).not.toContain('docc')
  })
})

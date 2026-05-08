import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test'
import {
  SwiftDoccAdapter,
  ARCHIVES,
  collectIndexPaths,
  pathToKey,
  keyToPath,
} from '../../../src/sources/swift-docc.js'

const originalFetch = globalThis.fetch

const FAKE_INDEX = {
  schemaVersion: { major: 0, minor: 1, patch: 0 },
  interfaceLanguages: {
    swift: [
      {
        path: '/documentation/diagnostics',
        title: 'Swift Compiler Diagnostics',
        type: 'collection',
        children: [
          { path: '/documentation/diagnostics/diagnostic-groups', title: 'Diagnostic Groups', type: 'article' },
          { path: '/documentation/diagnostics/existential-any', title: 'Existential any', type: 'article' },
        ],
      },
    ],
  },
}

const FAKE_LEAF = {
  schemaVersion: { major: 0, minor: 3, patch: 0 },
  identifier: { interfaceLanguage: 'swift', url: 'doc://diagnostics/documentation/diagnostics/existential-any' },
  metadata: { title: 'Existential any (ExistentialAny)', role: 'article' },
  kind: 'article',
  abstract: [{ type: 'text', text: 'Use any keyword on existential types.' }],
  sections: [],
  primaryContentSections: [
    {
      kind: 'content',
      content: [
        { type: 'heading', level: 2, anchor: 'Overview', text: 'Overview' },
        { type: 'paragraph', inlineContent: [{ type: 'text', text: 'The compiler now requires an explicit any.' }] },
      ],
    },
  ],
  topicSections: [],
  seeAlsoSections: [
    {
      title: 'See Also',
      identifiers: ['doc://diagnostics/documentation/diagnostics/diagnostic-groups'],
    },
  ],
  references: {
    'doc://diagnostics/documentation/diagnostics/diagnostic-groups': {
      identifier: 'doc://diagnostics/documentation/diagnostics/diagnostic-groups',
      kind: 'article',
      role: 'article',
      title: 'Diagnostic Groups',
      type: 'topic',
      url: '/documentation/diagnostics/diagnostic-groups',
    },
  },
}

function jsonResponse(body, { status = 200, etag = null } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: etag ? { 'content-type': 'application/json', etag } : { 'content-type': 'application/json' },
  })
}

function makeCtx(rootBySlug = {}) {
  return {
    db: {
      getRootBySlug: (slug) => rootBySlug[slug] ?? null,
      upsertRoot: mock((slug, displayName, kind, source) => {
        rootBySlug[slug] = { id: slug, slug, display_name: displayName, kind, source_type: source }
        return rootBySlug[slug]
      }),
    },
    rateLimiter: { acquire: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('SwiftDoccAdapter — static metadata', () => {
  test('exposes type, displayName, syncMode', () => {
    expect(SwiftDoccAdapter.type).toBe('swift-docc')
    expect(SwiftDoccAdapter.displayName).toBe('Swift Documentation Archives')
    expect(SwiftDoccAdapter.syncMode).toBe('flat')
  })
})

describe('SwiftDoccAdapter — discover', () => {
  beforeEach(() => {
    globalThis.fetch = async () => jsonResponse(FAKE_INDEX)
  })

  test('walks each archive index and produces scoped keys', async () => {
    const archiveCount = Object.keys(ARCHIVES).length
    const adapter = new SwiftDoccAdapter()
    const result = await adapter.discover(makeCtx())

    expect(result.keys.length).toBe(archiveCount * 3)
    expect(result.keys).toContain('swift-compiler/documentation/diagnostics')
    expect(result.keys).toContain('swift-compiler/documentation/diagnostics/diagnostic-groups')
    expect(result.keys).toContain('swift-package-manager/documentation/diagnostics')
    expect(result.keys).toContain('swift-migration-guide/documentation/diagnostics')
  })

  test('registers a root per archive', async () => {
    const adapter = new SwiftDoccAdapter()
    const result = await adapter.discover(makeCtx())
    const slugs = result.roots.map(r => r.slug).sort()
    expect(slugs).toEqual(['swift-compiler', 'swift-migration-guide', 'swift-package-manager'])
  })

  test('continues when one archive fails', async () => {
    let call = 0
    globalThis.fetch = async () => {
      call++
      if (call === 1) throw new Error('boom')
      return jsonResponse(FAKE_INDEX)
    }
    const adapter = new SwiftDoccAdapter()
    const result = await adapter.discover(makeCtx())
    expect(result.keys.length).toBeGreaterThan(0)
  })
})

describe('SwiftDoccAdapter — fetch / check URL routing', () => {
  test('fetch maps key back to docs.swift.org JSON URL for compiler archive', async () => {
    let capturedUrl = null
    globalThis.fetch = async (url) => {
      capturedUrl = url
      return jsonResponse(FAKE_LEAF, { etag: '"x"' })
    }
    const adapter = new SwiftDoccAdapter()
    await adapter.fetch('swift-compiler/documentation/diagnostics/existential-any', makeCtx())
    expect(capturedUrl).toBe('https://docs.swift.org/compiler/data/documentation/diagnostics/existential-any.json')
  })

  test('fetch maps key for swift-package-manager archive', async () => {
    let capturedUrl = null
    globalThis.fetch = async (url) => {
      capturedUrl = url
      return jsonResponse(FAKE_LEAF)
    }
    const adapter = new SwiftDoccAdapter()
    await adapter.fetch('swift-package-manager/documentation/packagemanagerdocs/usage', makeCtx())
    expect(capturedUrl).toBe('https://docs.swift.org/swiftpm/data/documentation/packagemanagerdocs/usage.json')
  })

  test('fetch maps key for migration archive (swift.org host)', async () => {
    let capturedUrl = null
    globalThis.fetch = async (url) => {
      capturedUrl = url
      return jsonResponse(FAKE_LEAF)
    }
    const adapter = new SwiftDoccAdapter()
    await adapter.fetch('swift-migration-guide/documentation/swift-6-concurrency-migration-guide/dataracesafety', makeCtx())
    expect(capturedUrl).toBe('https://www.swift.org/migration/data/documentation/swift-6-concurrency-migration-guide/dataracesafety.json')
  })

  test('check returns modified when etag changes', async () => {
    globalThis.fetch = async () => new Response('', {
      status: 200,
      headers: { etag: '"new"' },
    })
    const adapter = new SwiftDoccAdapter()
    const result = await adapter.check('swift-compiler/documentation/diagnostics', { etag: '"old"' }, makeCtx())
    expect(result.status).toBe('modified')
    expect(result.changed).toBe(true)
  })

  test('fetch throws on unknown archive slug', async () => {
    const adapter = new SwiftDoccAdapter()
    await expect(adapter.fetch('not-a-real-archive/documentation/foo', makeCtx())).rejects.toThrow(/Unknown swift-docc archive/)
  })
})

describe('SwiftDoccAdapter — normalize', () => {
  test('produces document with swift-docc sourceType and docs.swift.org URL', () => {
    const adapter = new SwiftDoccAdapter()
    const result = adapter.normalize('swift-compiler/documentation/diagnostics/existential-any', FAKE_LEAF)

    expect(result.document.sourceType).toBe('swift-docc')
    expect(result.document.framework).toBe('swift-compiler')
    expect(result.document.url).toBe('https://docs.swift.org/compiler/documentation/diagnostics/existential-any')
    expect(result.document.title).toBe('Existential any (ExistentialAny)')
  })

  test('rewrites resolved reference keys to scoped storage keys', () => {
    const adapter = new SwiftDoccAdapter()
    const result = adapter.normalize('swift-compiler/documentation/diagnostics/existential-any', FAKE_LEAF)

    const seeAlso = result.sections.find(s => s.sectionKind === 'see_also')
    expect(seeAlso).toBeDefined()
    const items = JSON.parse(seeAlso.contentJson)[0].items
    expect(items[0].key).toBe('swift-compiler/documentation/diagnostics/diagnostic-groups')
  })

  test('emits scoped child relationships for the migration archive', () => {
    const json = {
      ...FAKE_LEAF,
      topicSections: [{
        title: 'Migration',
        identifiers: ['doc://migrationguide/documentation/swift-6-concurrency-migration-guide/commonproblems'],
      }],
      references: {
        'doc://migrationguide/documentation/swift-6-concurrency-migration-guide/commonproblems': {
          url: '/documentation/swift-6-concurrency-migration-guide/commonproblems',
          title: 'Common Problems',
          type: 'topic',
        },
      },
    }

    const adapter = new SwiftDoccAdapter()
    const result = adapter.normalize('swift-migration-guide/documentation/migrationguide', json)

    const child = result.relationships.find(r => r.relationType === 'child')
    expect(child.toKey).toBe('swift-migration-guide/documentation/swift-6-concurrency-migration-guide/commonproblems')
  })
})

describe('SwiftDoccAdapter — extractReferences', () => {
  test('rewrites refs to scoped keys for downstream crawl seeds', () => {
    const adapter = new SwiftDoccAdapter()
    const refs = adapter.extractReferences(
      'swift-compiler/documentation/diagnostics/existential-any',
      FAKE_LEAF,
    )
    expect(refs).toContain('swift-compiler/documentation/diagnostics/diagnostic-groups')
  })
})

describe('helpers', () => {
  test('collectIndexPaths walks both top-level and nested children', () => {
    const paths = collectIndexPaths(FAKE_INDEX)
    expect(paths).toEqual([
      '/documentation/diagnostics',
      '/documentation/diagnostics/diagnostic-groups',
      '/documentation/diagnostics/existential-any',
    ])
  })

  test('pathToKey lowercases and prefixes with the slug', () => {
    expect(pathToKey('swift-compiler', '/documentation/Diagnostics/Foo'))
      .toBe('swift-compiler/documentation/diagnostics/foo')
  })

  test('keyToPath inverts pathToKey', () => {
    expect(keyToPath('swift-compiler', 'swift-compiler/documentation/diagnostics/foo'))
      .toBe('/documentation/diagnostics/foo')
  })

  test('keyToPath rejects keys outside the archive', () => {
    expect(() => keyToPath('swift-compiler', 'swiftpm/foo'))
      .toThrow(/does not belong to archive/)
  })
})

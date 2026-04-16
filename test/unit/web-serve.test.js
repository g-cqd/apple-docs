import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { startDevServer } from '../../src/web/serve.js'

let db
let ctx
let serverInfo

beforeEach(async () => {
  db = new DocsDatabase(':memory:')

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app UI',
    platforms: null,
    declaration: null,
    etag: null,
    lastModified: null,
    contentHash: 'test',
    downloadedAt: new Date().toISOString(),
    sourceType: 'apple-docc',
  })
  const docId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
  db.db.run(`INSERT OR REPLACE INTO document_sections (document_id, section_kind, heading, content_text, sort_order) VALUES (?, 'abstract', NULL, 'A type that represents part of your app UI', 0)`, [docId])

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app UI',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app UI', sortOrder: 0 },
    ],
    relationships: [
      { fromKey: 'documentation/swiftui/view', toKey: 'documentation/swiftui/text', relationType: 'child', section: 'Topics', sortOrder: 0 },
    ],
  })

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/text',
      title: 'Text',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Structure',
      framework: 'swiftui',
      abstractText: 'A view that displays read-only text.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A view that displays read-only text.', sortOrder: 0 },
    ],
    relationships: [],
  })

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/copying-data',
      title: 'Copying Data',
      kind: 'article',
      role: 'article',
      roleHeading: 'Article',
      framework: 'swiftui',
      abstractText: 'Learn how to copy values safely.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'Learn how to copy values safely.', sortOrder: 0 },
    ],
    relationships: [],
  })

  for (let i = 0; i < 24; i++) {
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: `documentation/swiftui/mock-${i}`,
        title: `Mock ${i}`,
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Structure',
        framework: 'swiftui',
        abstractText: `Synthetic result ${i}.`,
      },
      sections: [
        { sectionKind: 'abstract', contentText: `Synthetic result ${i}.`, sortOrder: 0 },
      ],
      relationships: [],
    })
  }

  ctx = { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } }
  serverInfo = await startDevServer({ port: 0 }, ctx)
})

afterEach(() => {
  serverInfo.server.stop(true)
  db.close()
})

describe('Dev Server (P7-E)', () => {
  test('serves landing page at /', async () => {
    const res = await fetch(`${serverInfo.url}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('swiftui')
  })

  test('serves document page at /docs/{key}', async () => {
    const res = await fetch(`${serverInfo.url}/docs/documentation/swiftui/view`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('View')
    expect(html).toContain('<!DOCTYPE html>')
  })

  test('serves framework listing at /docs/{slug}', async () => {
    const res = await fetch(`${serverInfo.url}/docs/swiftui`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('View')
    expect(html).toContain('id="tree-data"')
    expect(html).toContain('class="view-toggle"')
  })

  test('returns 404 for unknown document', async () => {
    const res = await fetch(`${serverInfo.url}/docs/nonexistent/path`)
    expect(res.status).toBe(404)
  })

  test('returns 404 for unknown path', async () => {
    const res = await fetch(`${serverInfo.url}/unknown`)
    expect(res.status).toBe(404)
  })

  test('serves CSS from /assets/', async () => {
    const res = await fetch(`${serverInfo.url}/assets/style.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  test('live search API works', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('title index endpoint returns v2 columnar format', async () => {
    const res = await fetch(`${serverInfo.url}/data/search/title-index.json`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.v).toBe(2)
    expect(data.frameworks).toBeDefined()
    expect(data.keys).toBeDefined()
    expect(data.titles).toBeDefined()
  })

  test('search manifest endpoint returns v2 with file mappings', async () => {
    const res = await fetch(`${serverInfo.url}/data/search/search-manifest.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-cache')
    const manifest = await res.json()
    expect(manifest.version).toBe(2)
    expect(manifest.files).toBeDefined()
    expect(manifest.files['title-index']).toMatch(/^title-index\.[0-9a-f]{10}\.json$/)
  })

  test('content-hashed search file returns immutable cache headers', async () => {
    // First get the manifest to find the hashed filename
    const manifestRes = await fetch(`${serverInfo.url}/data/search/search-manifest.json`)
    const manifest = await manifestRes.json()
    const titleFile = manifest.files['title-index']
    const res = await fetch(`${serverInfo.url}/data/search/${titleFile}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
    const data = await res.json()
    expect(data.v).toBe(2)
  })

  test('serves search page at /search', async () => {
    const res = await fetch(`${serverInfo.url}/search`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('search-form')
    expect(html).toContain('search-page.js')
  })

  test('serves search page at /search/', async () => {
    const res = await fetch(`${serverInfo.url}/search/`)
    expect(res.status).toBe(200)
  })

  test('/api/search accepts kind filter', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&kind=symbol`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/search kind filter matches displayed kinds', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=Copying&kind=Article`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toHaveLength(1)
    expect(data.results[0].path).toBe('documentation/swiftui/copying-data')
    expect(data.results[0].kind).toBe('Article')
  })

  test('/api/search accepts platform filter', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&platform=ios`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/search accepts limit and offset', async () => {
    const first = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=5&offset=0`)
    const second = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=5&offset=5`)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstData = await first.json()
    const secondData = await second.json()
    expect(firstData.results).toHaveLength(5)
    expect(secondData.results).toHaveLength(5)
    expect(firstData.results[0].path).not.toBe(secondData.results[0].path)
  })

  test('/api/search offset applies before pagination truncation', async () => {
    const first = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=10&offset=0`)
    const second = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=10&offset=10`)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstData = await first.json()
    const secondData = await second.json()
    const firstPaths = new Set(firstData.results.map(r => r.path))
    expect(secondData.results).toHaveLength(10)
    expect(secondData.results.every(r => !firstPaths.has(r.path))).toBe(true)
  })

  test('/api/search accepts min version filters', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&min_ios=13.0`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/filters returns filter options', async () => {
    const res = await fetch(`${serverInfo.url}/api/filters`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.frameworks).toBeArray()
    expect(data.kinds).toBeArray()
    // Frameworks now return {label, value} objects with display names
    const fwValues = data.frameworks.map(f => f.value)
    expect(fwValues).toContain('swiftui')
  })
})

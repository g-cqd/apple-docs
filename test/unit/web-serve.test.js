import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { startDevServer } from '../../src/web/serve.js'

let db
let ctx
let serverInfo

beforeEach(() => {
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

  ctx = { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } }
  serverInfo = startDevServer({ port: 0 }, ctx)
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

  test('title index endpoint works', async () => {
    const res = await fetch(`${serverInfo.url}/data/search/title-index.json`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.frameworks).toBeDefined()
    expect(data.entries).toBeDefined()
  })
})

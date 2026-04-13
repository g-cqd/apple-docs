import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { update } from '../../src/commands/update.js'

const originalFetch = globalThis.fetch
const originalToken = process.env.GITHUB_TOKEN

let dataDir
let db
let ctx
let fetchImpl

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-update-flat-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  process.env.GITHUB_TOKEN = 'test-token'

  fetchImpl = mock(async () => new Response('Not found', { status: 404 }))
  globalThis.fetch = mock((url, opts) => fetchImpl(url, opts))

  ctx = {
    db,
    dataDir,
    rateLimiter: { acquire: mock(() => Promise.resolve()), rate: 5 },
    logger: { info() {}, warn() {}, error() {} },
  }

  const root = db.upsertRoot('packages', 'Swift Package Catalog', 'collection', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'packages/apple/swift-argument-parser',
    url: 'https://github.com/apple/swift-argument-parser',
    title: 'apple/swift-argument-parser',
    role: 'article',
    abstract: 'Old package entry',
    sourceType: 'packages',
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken == null) Reflect.deleteProperty(process.env, 'GITHUB_TOKEN')
  else process.env.GITHUB_TOKEN = originalToken
  try { db.close() } catch {}
  rmSync(dataDir, { recursive: true, force: true })
})

describe('update flat sources', () => {
  test('removes pages that disappear from authoritative discovery', async () => {
    fetchImpl.mockImplementation(async (url) => {
      if (String(url).includes('raw.githubusercontent.com/SwiftPackageIndex/PackageList/main/packages.json')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"empty"' },
        })
      }
      return new Response('Not found', { status: 404 })
    })

    const result = await update({ sources: ['packages'] }, ctx)

    expect(result.delCount).toBe(1)
    expect(db.db.query('SELECT status FROM pages WHERE path = ?').get('packages/apple/swift-argument-parser').status).toBe('deleted')
    expect(db.getPage('packages/apple/swift-argument-parser')).toBeNull()
  })
})

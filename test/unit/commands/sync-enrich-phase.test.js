import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { DocsDatabase } from '../../../src/storage/database.js'
import { createLogger } from '../../../src/lib/logger.js'
import { runEnrichPhase } from '../../../src/commands/sync/enrich.js'

let dir
let assetPath
let db
const logger = createLogger('error')

function makeAssetDb(path) {
  const a = new Database(path)
  a.run('CREATE TABLE documents (asset_id TEXT PRIMARY KEY, document BLOB)')
  a.run('CREATE TABLE attributes (asset_id TEXT, vector_id INTEGER, chunk_index INTEGER, type TEXT, framework TEXT, title TEXT, content TEXT)')
  a.query('INSERT INTO documents VALUES (?, ?)').run('/documentation/SwiftUI/View', JSON.stringify({
    uri: '/documentation/SwiftUI/View', kind: 'symbol', role: 'symbol',
    external_id: 's:7SwiftUI4ViewP', modules: ['SwiftUI'],
    platforms: [{ platform: 'iOS', introduced: 13, deprecated: false }],
  }))
  a.query('INSERT INTO documents VALUES (?, ?)').run('/documentation/SwiftUI/View/novelmember', JSON.stringify({
    uri: '/documentation/SwiftUI/View/novelmember', kind: 'symbol', role: 'symbol', modules: ['SwiftUI'],
  }))
  a.query('INSERT INTO attributes VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('/documentation/SwiftUI/View/novelmember', 1, 0, 'symbol', 'SwiftUI', 'novelMember', 'novelMember\nA member the crawl missed.')
  a.close()
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-docs-enrich-phase-'))
  assetPath = makeAssetDb(join(dir, 'index.sql'))
  db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertNormalizedDocument({
    document: { sourceType: 'apple-docc', key: 'swiftui/view', title: 'View', framework: 'swiftui', role: 'symbol' },
    sections: [], relationships: [],
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runEnrichPhase', () => {
  test('applies the merge when given an explicit asset path', async () => {
    const result = await runEnrichPhase({ db, logger, assetDbPath: assetPath })
    expect(result.skipped).toBeUndefined()
    expect(result.usrBackfilled).toBe(1)
    expect(result.novelInserted).toBe(1)
    expect(db.db.query("SELECT usr FROM documents WHERE key='swiftui/view'").get().usr).toBe('s:7SwiftUI4ViewP')
    expect(db.db.query("SELECT COUNT(*) c FROM documents WHERE key='swiftui/view/novelmember'").get().c).toBe(1)
  })

  test('is idempotent across two runs', async () => {
    await runEnrichPhase({ db, logger, assetDbPath: assetPath })
    const second = await runEnrichPhase({ db, logger, assetDbPath: assetPath })
    expect(second.usrBackfilled).toBe(0)
    expect(second.novelInserted).toBe(0)
    expect(db.db.query("SELECT COUNT(*) c FROM documents WHERE key='swiftui/view/novelmember'").get().c).toBe(1)
  })

  test('skips when no local asset exists and the CDN download is not opted into', async () => {
    const prev = process.env.APPLE_DOCS_ENRICH_FETCH
    delete process.env.APPLE_DOCS_ENRICH_FETCH
    try {
      const result = await runEnrichPhase({ db, logger, findAssets: () => [] })
      expect(result.skipped).toBe(true)
      expect(result.error).toBeUndefined()
    } finally {
      if (prev != null) process.env.APPLE_DOCS_ENRICH_FETCH = prev
    }
  })

  test('a broken asset is non-fatal and reports the error', async () => {
    const broken = join(dir, 'broken.sql')
    await Bun.write(broken, 'not a sqlite file')
    const result = await runEnrichPhase({ db, logger, assetDbPath: broken })
    expect(result.skipped).toBe(true)
    expect(result.error).toBeDefined()
  })
})

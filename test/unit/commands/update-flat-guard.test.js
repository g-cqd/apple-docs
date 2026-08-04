import { describe, expect, test } from 'bun:test'
import { updateFlatSource } from '../../../src/commands/update/flat.js'
import { DocsDatabase } from '../../../src/storage/database.js'
import { Semaphore } from '../../../src/lib/semaphore.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeEnv(pageCount) {
  const db = new DocsDatabase(':memory:')
  db.upsertRoot('test-flat', 'Test Flat', 'collection', 'test-flat')
  const root = db.getRootBySlug('test-flat')
  const paths = []
  for (let i = 0; i < pageCount; i++) {
    const path = `test-flat/page-${i}`
    paths.push(path)
    db.upsertPage({
      rootId: root.id,
      path,
      url: `https://example.com/${path}`,
      etag: `"e${i}"`,
      sourceType: 'test-flat',
    })
  }
  const adapter = {
    constructor: { type: 'test-flat', displayName: 'Test Flat', syncMode: 'flat' },
    async check() { return { status: 'unchanged' } },
    validateNormalizeResult() {},
  }
  const ctx = { db, dataDir: '/tmp/apple-docs-flat-guard-test', logger: noopLogger, rateLimiter: { async acquire() {} } }
  return { db, root, paths, adapter, ctx }
}

const run = (adapter, discovery, ctx) =>
  updateFlatSource(adapter, discovery, null, 4, new Semaphore(4), ctx)

const activeCount = (db) =>
  db.db.query("SELECT COUNT(*) AS c FROM pages WHERE status = 'active'").get().c

describe('updateFlatSource staleness guard', () => {
  test('refuses a mass-tombstone when discovery lost most of the corpus', async () => {
    const { db, paths, adapter, ctx } = makeEnv(300)
    // Discovery only returned a third of the catalog (e.g. truncated listing).
    const discovery = { keys: paths.slice(0, 100) }

    const counts = await run(adapter, discovery, ctx)

    expect(counts.delCount).toBe(0)
    expect(activeCount(db)).toBe(300)
    db.close()
  })

  test('small stale sets still tombstone normally', async () => {
    const { db, paths, adapter, ctx } = makeEnv(60)
    const discovery = { keys: paths.slice(0, 30) }

    const counts = await run(adapter, discovery, ctx)

    expect(counts.delCount).toBe(30)
    expect(activeCount(db)).toBe(30)
    db.close()
  })

  test('partial discovery never tombstones out-of-scope pages', async () => {
    const { db, paths, adapter, ctx } = makeEnv(60)
    const discovery = { keys: paths.slice(0, 5), partial: true }

    const counts = await run(adapter, discovery, ctx)

    expect(counts.delCount).toBe(0)
    expect(activeCount(db)).toBe(60)
    db.close()
  })
})

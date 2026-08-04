import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// The index-gate fetches `${APPLE_DOCS_API_BASE}/index/<slug>` — point the
// module at a local server BEFORE importing anything that reads the env at
// module load (src/apple/api.js).
const state = {
  indexStatus: 200,
  indexEtag: '"idx-1"',
  indexBody: { interfaceLanguages: { swift: [] } },
  hits: [],
}

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    state.hits.push(url.pathname)
    if (url.pathname.startsWith('/index/')) {
      if (state.indexStatus === 404) return new Response('nope', { status: 404 })
      if (req.headers.get('if-none-match') === state.indexEtag) {
        return new Response(null, { status: 304 })
      }
      return new Response(JSON.stringify(state.indexBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: state.indexEtag },
      })
    }
    return new Response('not found', { status: 404 })
  },
})

process.env.APPLE_DOCS_API_BASE = `http://localhost:${server.port}`

const { updateDoccSource } = await import('../../../src/commands/update/docc.js')
const { DocsDatabase } = await import('../../../src/storage/database.js')
const { Semaphore } = await import('../../../src/lib/semaphore.js')

afterAll(() => server.stop(true))

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

function makeEnv({ sweepFresh = true } = {}) {
  const db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'technologies')
  const root = db.getRootBySlug('swiftui')
  db.upsertPage({
    rootId: root.id,
    path: 'swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    etag: '"page-1"',
    sourceType: 'apple-docc',
  })
  // Mark the root as already crawled so the new-root crawl branch is inert.
  db.setCrawlState('swiftui/view', 'processed', 'swiftui', 0)
  if (sweepFresh) {
    db.db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('docc_full_sweep_at', ?)", [new Date().toISOString()])
  }

  const checkedPaths = []
  const adapter = {
    constructor: { type: 'apple-docc', displayName: 'Apple Developer Documentation', syncMode: 'crawl' },
    async check(path) {
      checkedPaths.push(path)
      return { status: 'unchanged' }
    },
  }
  const ctx = {
    db,
    dataDir: '/tmp/apple-docs-gate-test',
    logger: noopLogger,
    rateLimiter: { rate: 100, async acquire() {} },
    fullSync: false,
  }
  return { db, root, adapter, ctx, checkedPaths }
}

const run = (adapter, ctx) =>
  updateDoccSource(adapter, { keys: [], roots: [] }, null, 4, 1, new Semaphore(4), ctx)

describe('updateDoccSource index gate', () => {
  beforeEach(() => {
    state.indexStatus = 200
    state.indexEtag = '"idx-1"'
    state.indexBody = { interfaceLanguages: { swift: [] } }
    state.hits = []
  })

  test('skips per-page checks when the stored index ETag still matches (304)', async () => {
    const { db, root, adapter, ctx, checkedPaths } = makeEnv()
    db.db.run('UPDATE roots SET index_etag = ? WHERE id = ?', [state.indexEtag, root.id])

    const counts = await run(adapter, ctx)

    expect(checkedPaths).toEqual([])
    expect(counts.skippedCount).toBe(1)
    expect(state.hits).toContain('/index/swiftui')
    db.close()
  })

  test('checks pages and stores the ETag on first sight (no stored ETag)', async () => {
    const { db, root, adapter, ctx, checkedPaths } = makeEnv()

    const counts = await run(adapter, ctx)

    expect(checkedPaths).toEqual(['swiftui/view'])
    expect(counts.skippedCount).toBe(0)
    // ETag committed only after the checks ran.
    expect(db.db.query('SELECT index_etag FROM roots WHERE id = ?').get(root.id).index_etag).toBe(state.indexEtag)
    db.close()
  })

  test('checks pages when the index ETag changed and seeds new paths from the index tree', async () => {
    const { db, root, adapter, ctx, checkedPaths } = makeEnv()
    db.db.run('UPDATE roots SET index_etag = ? WHERE id = ?', ['"stale"', root.id])
    state.indexBody = {
      interfaceLanguages: {
        swift: [
          {
            path: '/documentation/SwiftUI',
            title: 'SwiftUI',
            type: 'module',
            children: [
              { path: '/documentation/SwiftUI/View', title: 'View', type: 'symbol' },
              { path: '/documentation/SwiftUI/BrandNewAPI', title: 'BrandNewAPI', type: 'symbol' },
              { path: '/documentation/Updates/SwiftUI', title: 'Updates', type: 'article', external: true },
            ],
          },
        ],
      },
    }

    await run(adapter, ctx)

    expect(checkedPaths).toEqual(['swiftui/view'])
    // The unknown same-root page was seeded; the tracked page and the
    // external link were not.
    const pending = db.getPendingCrawl('swiftui', 10).map(r => r.path)
    expect(pending).toContain('swiftui/brandnewapi')
    expect(pending).not.toContain('updates/swiftui')
    db.close()
  })

  test('falls back to per-page checks when the index endpoint is missing (404)', async () => {
    const { db, adapter, ctx, checkedPaths } = makeEnv()
    state.indexStatus = 404

    const counts = await run(adapter, ctx)

    expect(checkedPaths).toEqual(['swiftui/view'])
    expect(counts.skippedCount).toBe(0)
    db.close()
  })

  test('full sweep bypasses the gate when the periodic stamp is stale', async () => {
    const { db, root, adapter, ctx, checkedPaths } = makeEnv({ sweepFresh: false })
    db.db.run('UPDATE roots SET index_etag = ? WHERE id = ?', [state.indexEtag, root.id])

    await run(adapter, ctx)

    expect(checkedPaths).toEqual(['swiftui/view'])
    // No index request at all on a sweep.
    expect(state.hits).toEqual([])
    // The sweep stamped itself at start.
    expect(db.db.query("SELECT value FROM schema_meta WHERE key = 'docc_full_sweep_at'").get()).toBeTruthy()
    db.close()
  })

  test('full sweep bypasses the gate on --full runs', async () => {
    const { db, root, adapter, ctx, checkedPaths } = makeEnv()
    db.db.run('UPDATE roots SET index_etag = ? WHERE id = ?', [state.indexEtag, root.id])
    ctx.fullSync = true

    await run(adapter, ctx)

    expect(checkedPaths).toEqual(['swiftui/view'])
    expect(state.hits).toEqual([])
    db.close()
  })
})

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { status } from '../../src/commands/status.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let db
let tmpDir
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-fresh-'))
  ctx = { db, dataDir: tmpDir, logger: { debug() {}, info() {}, warn() {}, error() {} } }
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Freshness checks (P8-E)', () => {
  test('no sync history returns stale with null dates', async () => {
    const result = await status({ skipUpdateCheck: true }, ctx)
    expect(result.freshness).toBeDefined()
    expect(result.freshness.lastSyncAt).toBeNull()
    expect(result.freshness.daysSinceSync).toBeNull()
    expect(result.freshness.isStale).toBe(true)
    expect(result.freshness.staleRoots).toEqual([])
  })

  test('recent sync is not stale', async () => {
    // Insert a recent update_log entry
    const now = new Date().toISOString()
    db.db.run("INSERT INTO update_log (action, timestamp) VALUES ('sync', ?)", [now])

    const result = await status({ skipUpdateCheck: true }, ctx)
    expect(result.freshness.daysSinceSync).toBe(0)
    expect(result.freshness.isStale).toBe(false)
  })

  test('old sync is stale', async () => {
    const old = new Date(Date.now() - 20 * 86400000).toISOString()
    db.db.run("INSERT INTO update_log (action, timestamp) VALUES ('sync', ?)", [old])

    const result = await status({ skipUpdateCheck: true }, ctx)
    expect(result.freshness.daysSinceSync).toBe(20)
    expect(result.freshness.isStale).toBe(true)
  })

  test('detects stale roots', async () => {
    const now = new Date().toISOString()
    db.db.run("INSERT INTO update_log (action, timestamp) VALUES ('sync', ?)", [now])

    // Insert a per-root update_log entry that is stale
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const old = new Date(Date.now() - 20 * 86400000).toISOString()
    db.db.run("INSERT INTO update_log (action, timestamp, root_slug) VALUES ('sync', ?, 'swiftui')", [old])

    const result = await status({ skipUpdateCheck: true }, ctx)
    expect(result.freshness.staleRoots.length).toBe(1)
    expect(result.freshness.staleRoots[0].slug).toBe('swiftui')
  })

  test('fresh root is not in stale roots', async () => {
    const now = new Date().toISOString()
    db.db.run("INSERT INTO update_log (action, timestamp) VALUES ('sync', ?)", [now])

    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.db.run("INSERT INTO update_log (action, timestamp, root_slug) VALUES ('sync', ?, 'swiftui')", [now])

    const result = await status({ skipUpdateCheck: true }, ctx)
    expect(result.freshness.staleRoots.length).toBe(0)
  })
})

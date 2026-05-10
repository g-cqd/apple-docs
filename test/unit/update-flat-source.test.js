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
  // Helper: every fetch (README, list, etc.) returns 404. The packages
  // adapter's `official` discovery scope is in-process (the curated
  // OFFICIAL_PACKAGES allowlist) so the discovery itself succeeds; only
  // per-page README fetches flap, which is what triggers `case 'deleted'`
  // in the per-page check loop.
  const all404 = () => fetchImpl.mockImplementation(async () => new Response('Not found', { status: 404 }))

  test('persistent 404s tombstone after N=3 consecutive cycles (Audit 5 §4.3)', async () => {
    all404()

    // Run 1: bumps consecutive_404_count to 1; no tombstone yet.
    const r1 = await update({ sources: ['packages'] }, ctx)
    expect(r1.delCount).toBe(0)
    let row = db.db.query('SELECT status, consecutive_404_count FROM pages WHERE path = ?').get('packages/apple/swift-argument-parser')
    expect(row.status).toBe('active')
    expect(row.consecutive_404_count).toBe(1)

    // Run 2: 2/3, still no tombstone.
    const r2 = await update({ sources: ['packages'] }, ctx)
    expect(r2.delCount).toBe(0)
    row = db.db.query('SELECT status, consecutive_404_count FROM pages WHERE path = ?').get('packages/apple/swift-argument-parser')
    expect(row.status).toBe('active')
    expect(row.consecutive_404_count).toBe(2)

    // Run 3: streak hits the threshold; the page tombstones.
    const r3 = await update({ sources: ['packages'] }, ctx)
    expect(r3.delCount).toBe(1)
    row = db.db.query('SELECT status FROM pages WHERE path = ?').get('packages/apple/swift-argument-parser')
    expect(row.status).toBe('deleted')
  })

  test('clearTombstoneCounter resets the streak (unit-level)', () => {
    // The reset is exercised by the adapter on `unchanged`/`modified`
    // outcomes; mocking those requires fetch-level shaping that's brittle.
    // Verify the repo primitive directly: bump → bump → reset → 0.
    db.bumpConsecutive404('packages/apple/swift-argument-parser')
    expect(
      db.bumpConsecutive404('packages/apple/swift-argument-parser'),
    ).toBe(2)
    db.resetConsecutive404('packages/apple/swift-argument-parser')
    const row = db.db.query('SELECT consecutive_404_count FROM pages WHERE path = ?').get('packages/apple/swift-argument-parser')
    expect(row.consecutive_404_count).toBe(0)
  })
})

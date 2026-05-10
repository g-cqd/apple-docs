/**
 * P2.3 — partial-results contract.
 *
 * When a deep contribution (fuzzy or body) hits its per-op deadline,
 * the search response must flag `partial: true` and include the
 * timed-out tier in `partialReasons`. Strict-cascade results already
 * accumulated MUST be returned; the deep failure cannot sink the
 * whole response.
 *
 * The test injects a stub `readerPool.run()` that resolves cheap ops
 * normally and throws `DeadlineError` for `searchBody`. We exercise
 * the cascade against an in-memory database so the strict tier
 * actually produces hits, then assert the envelope.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { DeadlineError } from '../../src/storage/reader-pool.js'

let tmpDir
let db
let dbPath

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-partial-test-'))
  dbPath = join(tmpDir, 'apple-docs.db')
  db = new DocsDatabase(dbPath)

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app\'s user interface.',
    platforms: null,
    declaration: 'protocol View',
    sourceType: 'apple-docc',
  })
  db.markConverted('documentation/swiftui/view')
})

afterAll(() => {
  try { db.close() } catch {}
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

/**
 * Stub readerPool that throws DeadlineError for the named op and
 * delegates everything else back to the main-thread DB handle.
 */
function makeStubPoolThatTimesOut(timeoutOp) {
  return {
    async run(op, args) {
      if (op === timeoutOp) {
        throw new DeadlineError(op, 100)
      }
      // Fall through to the main-thread method for cheap ops.
      const fn = db[op]
      if (typeof fn !== 'function') throw new Error(`stub: db has no ${op}`)
      return fn.apply(db, args)
    },
    stats: () => ({ size: 0, active: 0, pending: 0, spawns: 0, errors: 0, timeouts: 0, backpressureRejects: 0 }),
  }
}

describe('search partial-on-deep-timeout', () => {
  test('flags partial=true with body in partialReasons when searchBody hits deadline', async () => {
    // Force the body branch to engage by claiming the body index exists.
    // In an unseeded test DB the body FTS table is empty so the cascade
    // would short-circuit; stubbing the count is the minimal nudge.
    const dbProxy = new Proxy(db, {
      get(target, prop) {
        if (prop === 'getBodyIndexCount') return () => 1
        const value = target[prop]
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const ctx = {
      db: dbProxy,
      dataDir: tmpDir,
      logger: { warn() {}, info() {}, error() {} },
      readerPool: makeStubPoolThatTimesOut('searchBody'),
    }
    // `noEager: true` forces the body branch to run even if fast tiers
    // already filled the window. `fuzzy: false` keeps fuzzy out of the path
    // so we only assert the body branch's behavior.
    const out = await search({
      query: 'View',
      noEager: true,
      fuzzy: false,
      limit: 10,
    }, ctx)
    expect(out.partial).toBe(true)
    expect(out.partialReasons).toContain('body')
    // Strict cascade still produced the View result.
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0].path).toBe('documentation/swiftui/view')
  })

  test('flags partial=true with fuzzy in partialReasons when fuzzyMatchTitles hits deadline', async () => {
    const ctx = {
      db,
      dataDir: tmpDir,
      logger: { warn() {}, info() {}, error() {} },
      readerPool: makeStubPoolThatTimesOut('fuzzyMatchTitles'),
    }
    // Force fuzzy to engage by giving an unmatchable typo'd query.
    const out = await search({
      query: 'Vieww',
      fuzzy: true,
      limit: 10,
    }, ctx)
    expect(out.partial).toBe(true)
    expect(out.partialReasons).toContain('fuzzy')
  })

  test('omits partial flag when no deep deadline fires', async () => {
    const ctx = {
      db,
      dataDir: tmpDir,
      logger: { warn() {}, info() {}, error() {} },
    }
    const out = await search({ query: 'View', fuzzy: false, limit: 10 }, ctx)
    expect(out.partial).toBeUndefined()
    expect(out.partialReasons).toBeUndefined()
  })
})

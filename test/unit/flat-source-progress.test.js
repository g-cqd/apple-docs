import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import {
  markFlatSourceFailed,
  markFlatSourceProcessed,
  seedFlatSourceProgress,
} from '../../src/lib/flat-source-progress.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('flat-source progress helpers', () => {
  test('seedFlatSourceProgress clears stale rows and seeds pending or processed states', () => {
    db.setCrawlState('swift-evolution/old-entry', 'failed', 'swift-evolution', 0, 'timeout')

    seedFlatSourceProgress(
      db,
      'swift-evolution',
      ['swift-evolution/0001', 'swift-evolution/0002'],
      new Set(['swift-evolution/0001']),
    )

    const stats = db.getCrawlStats('swift-evolution')
    expect(stats.processed).toBe(1)
    expect(stats.pending).toBe(1)
    expect(stats.failed).toBe(0)
  })

  test('markFlatSourceProcessed and markFlatSourceFailed update per-key progress', () => {
    seedFlatSourceProgress(db, 'sample-code', ['sample-code/foo', 'sample-code/bar'])

    markFlatSourceProcessed(db, 'sample-code', 'sample-code/foo')
    markFlatSourceFailed(db, 'sample-code', 'sample-code/bar', 'Not found')

    const stats = db.getCrawlStats('sample-code')
    expect(stats.processed).toBe(1)
    expect(stats.failed).toBe(1)
    expect(stats.pending).toBe(0)
  })
})

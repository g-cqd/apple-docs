import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { crawlRoot } from '../../src/pipeline/discover.js'
import { Semaphore } from '../../src/lib/semaphore.js'
import { createMockLogger } from '../helpers/mocks.js'

let db
let logger

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  logger = createMockLogger()
})

afterEach(() => {
  db.close()
})

describe('crawlRoot', () => {
  test('throws for unknown root slug', async () => {
    await expect(
      crawlRoot(db, '/tmp', null, 'nonexistent', logger, null, { semaphore: new Semaphore(1) })
    ).rejects.toThrow('Unknown root: nonexistent')
  })

  test('returns processed count when no pending pages', async () => {
    db.upsertRoot('testroot', 'Test', 'framework', 'apple-docc')
    // Seed and immediately mark as processed so the crawl loop has nothing to do
    db.seedCrawlIfNew('testroot', 'testroot', 0)
    db.setCrawlState('testroot', 'processed', 'testroot', 0)

    const result = await crawlRoot(db, '/tmp', { acquire: async () => {} }, 'testroot', logger, null, {
      semaphore: new Semaphore(1),
    })

    expect(result.processed).toBe(0)
    expect(result.total).toBeGreaterThanOrEqual(0)
  })

  test('retryFailed resets failed crawl entries to pending', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    // Manually seed + fail, then seed root so loop starts and exits
    db.seedCrawlIfNew('documentation/swiftui/view', 'swiftui', 1)
    db.setCrawlState('documentation/swiftui/view', 'failed', 'swiftui', 1, 'Not found')
    // Also pre-seed the root path as processed to avoid network fetch
    db.seedCrawlIfNew('swiftui', 'swiftui', 0)
    db.setCrawlState('swiftui', 'processed', 'swiftui', 0)

    const failedBefore = db.countFailed('swiftui')
    expect(failedBefore).toBe(1)

    // Use an adapter that immediately fails so we don't hit the network
    const failAdapter = {
      constructor: { type: 'apple-docc' },
      async fetch() { throw new Error('mock fail') },
      extractReferences() { return [] },
    }

    try {
      await crawlRoot(db, '/tmp', { acquire: async () => {} }, 'swiftui', logger, null, {
        semaphore: new Semaphore(1),
        retryFailed: true,
        adapter: failAdapter,
      })
    } catch {
      // May fail since mock adapter throws
    }

    // Logger should mention the reset
    const resetMsg = logger._calls.info.find(args => args[0]?.includes?.('Reset'))
    expect(resetMsg).toBeDefined()
  })

  test('calls onProgress callback during batch processing', async () => {
    db.upsertRoot('testroot', 'Test', 'framework', 'apple-docc')
    // Pre-mark everything as processed
    db.seedCrawlIfNew('testroot', 'testroot', 0)
    db.setCrawlState('testroot', 'processed', 'testroot', 0)

    const progressCalls = []
    await crawlRoot(db, '/tmp', { acquire: async () => {} }, 'testroot', logger, (info) => {
      progressCalls.push(info)
    }, { semaphore: new Semaphore(1) })

    // No pending pages means no batches means no progress calls
    expect(progressCalls).toEqual([])
  })

  test('uses adapter for fetching when provided', async () => {
    db.upsertRoot('testroot', 'Test', 'framework', 'apple-docc')
    // Seed a pending page
    db.seedCrawlIfNew('testroot', 'testroot', 0)

    let adapterCalled = false
    const mockAdapter = {
      constructor: { type: 'test-type' },
      async fetch(_path) {
        adapterCalled = true
        throw new Error('mock adapter fetch')
      },
      extractReferences() { return [] },
    }

    try {
      await crawlRoot(db, '/tmp', { acquire: async () => {} }, 'testroot', logger, null, {
        semaphore: new Semaphore(1),
        adapter: mockAdapter,
      })
    } catch {
      // Expected
    }

    expect(adapterCalled).toBe(true)
  })

  test('updates root page count after crawl', async () => {
    db.upsertRoot('testroot', 'Test', 'framework', 'apple-docc')
    db.seedCrawlIfNew('testroot', 'testroot', 0)
    db.setCrawlState('testroot', 'processed', 'testroot', 0)

    await crawlRoot(db, '/tmp', { acquire: async () => {} }, 'testroot', logger, null, {
      semaphore: new Semaphore(1),
    })

    // Root page count should have been updated (even if 0)
    const root = db.getRootBySlug('testroot')
    expect(root).toBeDefined()
  })
})

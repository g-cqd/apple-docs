// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isTransientError, retryTransientFailures } from '../../../src/commands/consolidate/retry-transient.js'
import { DocsDatabase } from '../../../src/storage/database.js'

let db
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-index', null, 'apple-docc')
  ctx = {
    db,
    dataDir: '/tmp/unused',
    rateLimiter: { acquire: async () => {} },
    logger: { info() {}, warn() {} },
  }
})
afterEach(() => db.close())

const seedFailure = (path, error) => {
  db.seedCrawlIfNew(path, 'swiftui', 1)
  db.setCrawlState(path, 'failed', 'swiftui', 1, error)
}
const statusOf = (path) => db.db.query('SELECT status FROM crawl_state WHERE path = ?').get(path)?.status

describe('isTransientError', () => {
  test('classifies 5xx / 408 / 429 / transport errors as transient', () => {
    expect(isTransientError('HTTP 500 fetching https://x.json')).toBe(true)
    expect(isTransientError('HTTP 503 fetching https://x.json')).toBe(true)
    expect(isTransientError('HTTP 429 fetching https://x.json')).toBe(true)
    expect(isTransientError('HTTP 408 fetching https://x.json')).toBe(true)
    expect(isTransientError('fetch failed')).toBe(true)
    expect(isTransientError('The request timed out')).toBe(true)
    expect(isTransientError('connect ECONNRESET 17.253.1.1:443')).toBe(true)
  })

  test('treats 404 / 403 / other 4xx as permanent', () => {
    expect(isTransientError('Not found')).toBe(false)
    expect(isTransientError('HTTP 403 fetching https://x.json')).toBe(false)
    expect(isTransientError('HTTP 404 fetching https://x.json')).toBe(false)
    expect(isTransientError('HTTP 400 fetching https://x.json')).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError(undefined)).toBe(false)
  })
})

describe('retryTransientFailures', () => {
  test('re-fetches only transient failures and marks them processed', async () => {
    seedFailure('swiftui/a', 'HTTP 503 fetching https://x.json')
    seedFailure('swiftui/b', 'Not found')
    seedFailure('swiftui/c', 'HTTP 403 fetching https://x.json')

    const fetched = []
    const res = await retryTransientFailures(ctx, {
      rounds: 1,
      baseDelayMs: 0,
      sleep: async () => {},
      fetchPage: async (path) => {
        fetched.push(path)
        return { json: { metadata: { title: 't' } }, etag: null, lastModified: null }
      },
      persist: async () => {},
    })

    expect(fetched).toEqual(['swiftui/a']) // only the transient one is retried
    expect(res.recovered).toBe(1)
    expect(statusOf('swiftui/a')).toBe('processed')
    expect(statusOf('swiftui/b')).toBe('failed') // 404 untouched
    expect(statusOf('swiftui/c')).toBe('failed') // 403 untouched
  })

  test('keeps a still-failing transient page failed across rounds', async () => {
    seedFailure('swiftui/a', 'HTTP 503 fetching https://x.json')
    let attempts = 0
    const res = await retryTransientFailures(ctx, {
      rounds: 2,
      baseDelayMs: 0,
      sleep: async () => {},
      fetchPage: async () => {
        attempts++
        throw new Error('HTTP 503 fetching https://x.json')
      },
      persist: async () => {},
    })
    expect(attempts).toBe(2) // retried both rounds
    expect(res.recovered).toBe(0)
    expect(statusOf('swiftui/a')).toBe('failed')
  })

  test('no transient failures means no rounds and no backoff', async () => {
    seedFailure('swiftui/b', 'Not found')
    let slept = false
    const res = await retryTransientFailures(ctx, {
      rounds: 3,
      baseDelayMs: 10_000,
      sleep: async () => {
        slept = true
      },
      fetchPage: async () => {
        throw new Error('should not fetch')
      },
    })
    expect(res.rounds).toBe(0)
    expect(res.recovered).toBe(0)
    expect(slept).toBe(false)
  })
})

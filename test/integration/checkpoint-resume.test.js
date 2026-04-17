import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { consolidate } from '../../src/commands/consolidate.js'
import { rebuildBody } from '../../src/commands/index-rebuild.js'
import { DocsDatabase } from '../../src/storage/database.js'
import { createMockLogger, createMockRateLimiter } from '../helpers/mocks.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()
const originalFetch = globalThis.fetch

let dataDir
let db
let logger
let rateLimiter

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-checkpoint-'))
  mkdirSync(join(dataDir, 'raw-json'), { recursive: true })
  mkdirSync(join(dataDir, 'markdown'), { recursive: true })
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  logger = createMockLogger()
  rateLimiter = createMockRateLimiter()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('checkpoint resume flows (P10)', () => {
  test('rebuildBody resumes from the saved checkpoint after interruption', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    for (let index = 0; index < 501; index++) {
      db.upsertNormalizedDocument({
        document: {
          sourceType: 'apple-docc',
          key: `swiftui/doc-${index}`,
          title: `Doc ${index}`,
          kind: 'symbol',
          role: 'symbol',
          framework: 'swiftui',
          abstractText: `Body ${index}`,
        },
        sections: [
          { sectionKind: 'abstract', contentText: `Body ${index}`, sortOrder: 0 },
        ],
        relationships: [],
      })
    }

    await expect(rebuildBody({}, {
      db,
      dataDir,
      logger,
      onProgress(progress) {
        if (progress.indexed >= 500) {
          throw new Error('interrupt body rebuild')
        }
      },
    })).rejects.toThrow('interrupt body rebuild')

    expect(db.getBodyIndexCount()).toBe(500)
    expect(db.getSyncCheckpoint('body-index:full')).toMatchObject({
      indexed: 500,
      total: 501,
    })

    const resumed = await rebuildBody({}, { db, dataDir, logger })
    expect(resumed.indexed).toBe(501)
    expect(resumed.total).toBe(501)
    expect(db.getBodyIndexCount()).toBe(501)
    expect(db.getSyncCheckpoint('body-index:full')).toBeNull()
  })

  test('consolidate resumes resolved retries from the saved checkpoint', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.seedCrawlIfNew('swiftui/old-a', 'swiftui', 1)
    db.seedCrawlIfNew('swiftui/old-b', 'swiftui', 1)
    db.setCrawlState('swiftui/old-a', 'failed', 'swiftui', 1, 'Not found')
    db.setCrawlState('swiftui/old-b', 'failed', 'swiftui', 1, 'Not found')
    writeFileSync(join(dataDir, 'raw-json', 'swiftui.json'), JSON.stringify({
      references: {
        'swiftui/old-a': { url: 'swiftui/new-a', title: 'New A' },
        'swiftui/old-b': { url: 'swiftui/new-b', title: 'New B' },
      },
    }))

    let fetchCalls = 0
    globalThis.fetch = async () => {
      fetchCalls++
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: '"test-etag"',
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      })
    }

    await expect(consolidate({}, {
      db,
      dataDir,
      rateLimiter,
      logger,
      semaphore: { max: 1 },
      onProgress(progress) {
        if (progress.phase === 'consolidate-retry' && progress.completed === 1) {
          throw new Error('interrupt consolidate retry')
        }
      },
    })).rejects.toThrow('interrupt consolidate retry')

    expect(db.getSyncCheckpoint('consolidate:retry-resolved')).toMatchObject({
      nextIndex: 1,
      retried: 1,
      retriedOk: 1,
    })
    expect(db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c).toBe(1)

    const resumed = await consolidate({}, {
      db,
      dataDir,
      rateLimiter,
      logger,
      semaphore: { max: 1 },
    })

    expect(resumed.retried).toBe(2)
    expect(resumed.retriedOk).toBe(2)
    expect(fetchCalls).toBe(2)
    expect(db.getSyncCheckpoint('consolidate:retry-resolved')).toBeNull()
    expect(db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c).toBe(0)
  })
})

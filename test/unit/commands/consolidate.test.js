import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../../src/storage/database.js'
import { consolidate, verifyCorpusIntegrity } from '../../../src/commands/consolidate.js'
import { createMockLogger, createMockRateLimiter } from '../../helpers/mocks.js'

const fixture = await Bun.file(new URL('../../fixtures/swiftui-view.json', import.meta.url)).json()
const originalFetch = globalThis.fetch

let db
let dataDir
let logger
let rateLimiter

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'consolidate-test-'))
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

describe('consolidate', () => {
  test('minify walk stamps itself done after a zero-result pass and skips thereafter', async () => {
    await consolidate({ minify: true }, { db, dataDir, rateLimiter, logger })
    expect(db.db.query("SELECT value FROM schema_meta WHERE key = 'raw_json_minified'").get()).toBeTruthy()

    // Second run: the walk is skipped (log line instead of a minify pass).
    await consolidate({ minify: true }, { db, dataDir, rateLimiter, logger })
    const skipLog = logger._calls.info.find(entry => String(entry[0]).includes('already minified'))
    expect(skipLog).toBeTruthy()

    // Explicit --minify (forceMinify) still walks.
    await consolidate({ minify: true, forceMinify: true }, { db, dataDir, rateLimiter, logger })
    const walkLog = logger._calls.info.filter(entry => String(entry[0]).includes('Minifying JSON files'))
    expect(walkLog.length).toBeGreaterThanOrEqual(2)
  })

  test('sweeps orphan document relationships', async () => {
    db.upsertNormalizedDocument({
      document: { sourceType: 'apple-docc', key: 'swiftui/view', title: 'View' },
      sections: [],
      relationships: [{ toKey: 'swiftui/ghost', relationType: 'child', sortOrder: 0 }],
    })
    // Orphan both directions: a from_key with no document, and the to_key
    // above which never existed.
    db.db.run(
      "INSERT INTO document_relationships (from_key, to_key, relation_type, sort_order) VALUES ('swiftui/gone', 'swiftui/view', 'child', 0)",
    )
    const before = db.db.query('SELECT COUNT(*) AS c FROM document_relationships').get().c
    expect(before).toBe(2)

    await consolidate({}, { db, dataDir, rateLimiter, logger })

    const rows = db.db.query('SELECT from_key, to_key FROM document_relationships').all()
    expect(rows).toEqual([])
  })

  test('returns zeros for empty database', async () => {
    const result = await consolidate({ dryRun: true }, { db, dataDir, rateLimiter, logger })
    expect(result.analyzed).toBe(0)
    expect(result.cleaned).toBe(0)
    expect(result.resolved).toBe(0)
    expect(result.dryRun).toBe(true)
  })

  test('cleans up invalid paths (fragments)', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    // Insert a failed crawl entry with a fragment URL
    db.seedCrawlIfNew('documentation/swiftui#section', 'swiftui', 1)
    db.setCrawlState('documentation/swiftui#section', 'failed', 'swiftui', 1, 'Not found')

    const result = await consolidate({}, { db, dataDir, rateLimiter, logger })
    expect(result.analyzed).toBe(1)
    expect(result.cleaned).toBe(1)
  })

  test('drops cross-adapter false positives and JSON:API artifacts', async () => {
    // swift-compiler is served by the swift-docc adapter (docs.swift.org), not
    // apple-docc — the bare /documentation/swift-compiler 404 is a false positive.
    db.upsertRoot('swift-compiler', 'Swift Compiler', 'tooling', 'swift-docc', null, 'swift-docc')
    db.upsertRoot('enterpriseprogramapi', 'Enterprise', 'framework', 'apple-docc')
    db.seedCrawlIfNew('swift-compiler', 'swift-compiler', 0)
    db.setCrawlState('swift-compiler', 'failed', 'swift-compiler', 0, 'Not found')
    // JSON:API relationship node — a structural artifact, not a page.
    const artifact = 'enterpriseprogramapi/profile/relationships-data.dictionary/links'
    db.seedCrawlIfNew(artifact, 'enterpriseprogramapi', 2)
    db.setCrawlState(artifact, 'failed', 'enterpriseprogramapi', 2, 'Not found')

    const result = await consolidate({}, { db, dataDir, rateLimiter, logger })
    expect(result.crossAdapter).toBe(1)
    expect(result.cleaned).toBe(1)
    const remaining = db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c
    expect(remaining).toBe(0)
  })

  test('dry run does not delete entries', async () => {
    db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
    db.seedCrawlIfNew('documentation/swiftui#section', 'swiftui', 1)
    db.setCrawlState('documentation/swiftui#section', 'failed', 'swiftui', 1, 'Not found')

    const result = await consolidate({ dryRun: true }, { db, dataDir, rateLimiter, logger })
    expect(result.cleaned).toBe(1)
    expect(result.dryRun).toBe(true)

    // Entry should still exist because dry run
    const remaining = db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c
    expect(remaining).toBe(1)
  })

  test('minify option minifies JSON files', async () => {
    // Create a non-minified JSON file
    const prettyJson = JSON.stringify({ key: 'value', nested: { a: 1 } }, null, 2)
    writeFileSync(join(dataDir, 'raw-json', 'test.json'), prettyJson)

    const result = await consolidate({ minify: true }, { db, dataDir, rateLimiter, logger })
    expect(result.minified).toBe(1)
    expect(result.minifySaved).toBeGreaterThan(0)
  })

  test('retries resolved paths with pooled concurrency', async () => {
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

    let active = 0
    let maxActive = 0
    let releaseFetches
    const fetchGate = new Promise((resolve) => {
      releaseFetches = resolve
    })

    globalThis.fetch = async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await fetchGate
      active--
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: '"test-etag"',
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
        },
      })
    }

    const runPromise = consolidate({}, {
      db,
      dataDir,
      rateLimiter,
      logger,
      semaphore: { max: 2 },
    })

    for (let attempt = 0; attempt < 100 && maxActive < 2; attempt++) {
      await Bun.sleep(1)
    }
    releaseFetches()
    const result = await runPromise

    expect(maxActive).toBe(2)
    expect(result.resolved).toBe(2)
    expect(result.retried).toBe(2)
    expect(result.retriedOk).toBe(2)
  })
})

describe('verifyCorpusIntegrity', () => {
  test('returns all ok for empty database', () => {
    const result = verifyCorpusIntegrity(db, dataDir, logger)
    expect(result.allOk).toBe(true)
    expect(result.checks.length).toBeGreaterThan(0)
  })

  test('detects orphan sections', () => {
    // Plant a section referencing a non-existent document. Foreign keys are
    // enforced from P1.8 onward, so bypass them just for this fixture.
    db.db.run('PRAGMA foreign_keys = OFF')
    db.db.run(
      "INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [99999, 'overview', 'Test', 'text', null, 0]
    )
    db.db.run('PRAGMA foreign_keys = ON')

    const result = verifyCorpusIntegrity(db, dataDir, logger)
    const orphanCheck = result.checks.find(c => c.name === 'orphan_sections')
    expect(orphanCheck).toBeDefined()
    expect(orphanCheck.ok).toBe(false)
  })

  test('FTS integrity check passes for clean DB', () => {
    const result = verifyCorpusIntegrity(db, dataDir, logger)
    const ftsCheck = result.checks.find(c => c.name === 'documents_fts')
    expect(ftsCheck).toBeDefined()
    expect(ftsCheck.ok).toBe(true)
  })

  test('document_page_consistency check for empty DB', () => {
    const result = verifyCorpusIntegrity(db, dataDir, logger)
    const consistencyCheck = result.checks.find(c => c.name === 'document_page_consistency')
    expect(consistencyCheck).toBeDefined()
    expect(consistencyCheck.ok).toBe(true)
  })
})

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { consolidate, verifyCorpusIntegrity } from '../../src/commands/consolidate.js'
import { createMockLogger, createMockRateLimiter } from '../helpers/mocks.js'

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
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('consolidate', () => {
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
})

describe('verifyCorpusIntegrity', () => {
  test('returns all ok for empty database', () => {
    const result = verifyCorpusIntegrity(db, dataDir, logger)
    expect(result.allOk).toBe(true)
    expect(result.checks.length).toBeGreaterThan(0)
  })

  test('detects orphan sections', () => {
    // Insert a section referencing a non-existent document
    db.db.run(
      "INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      [99999, 'overview', 'Test', 'text', null, 0]
    )

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

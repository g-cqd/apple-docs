import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { verifyCorpusIntegrity } from '../../src/commands/consolidate.js'

let db
let tmpDir
let logger

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-integrity-'))
  logger = { debug() {}, info() {}, warn() {}, error() {} }
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Corpus Integrity (P8-F)', () => {
  test('healthy DB passes all checks', () => {
    const result = verifyCorpusIntegrity(db, tmpDir, logger)
    expect(result.allOk).toBe(true)
    expect(result.checks.length).toBeGreaterThanOrEqual(4)
  })

  test('detects orphan sections', () => {
    // Insert a section with a non-existent document_id
    db.db.run("INSERT INTO document_sections (document_id, section_kind, content_text, sort_order) VALUES (99999, 'abstract', 'orphan', 0)")

    const result = verifyCorpusIntegrity(db, tmpDir, logger)
    const orphanCheck = result.checks.find(c => c.name === 'orphan_sections')
    expect(orphanCheck.ok).toBe(false)
    expect(result.allOk).toBe(false)
  })

  test('detects orphan relationships', () => {
    db.db.run("INSERT INTO document_relationships (from_key, to_key, relation_type) VALUES ('documentation/test/missing-source', 'documentation/test/missing-target', 'conformsTo')")

    const result = verifyCorpusIntegrity(db, tmpDir, logger)
    const relCheck = result.checks.find(c => c.name === 'orphan_relationships')
    expect(relCheck.ok).toBe(false)
  })

  test('detects missing raw-json files', () => {
    // Create raw-json dir (simulating a full-tier install) but don't create the file
    mkdirSync(join(tmpDir, 'raw-json'), { recursive: true })
    const now = new Date().toISOString()
    db.db.run("INSERT INTO documents (source_type, key, title, kind, role, framework, created_at, updated_at) VALUES ('apple-docc', 'documentation/test/missing', 'Missing', 'symbol', 'symbol', 'test', ?, ?)", [now, now])

    const result = verifyCorpusIntegrity(db, tmpDir, logger)
    const fileCheck = result.checks.find(c => c.name === 'raw_json_files')
    expect(fileCheck.ok).toBe(false)
  })

  test('passes file check when files exist', () => {
    const now = new Date().toISOString()
    db.db.run("INSERT INTO documents (source_type, key, title, kind, role, framework, created_at, updated_at) VALUES ('apple-docc', 'documentation/test/exists', 'Exists', 'symbol', 'symbol', 'test', ?, ?)", [now, now])

    // Create the expected file
    mkdirSync(join(tmpDir, 'raw-json', 'documentation', 'test'), { recursive: true })
    writeFileSync(join(tmpDir, 'raw-json', 'documentation', 'test', 'exists.json'), '{}')

    const result = verifyCorpusIntegrity(db, tmpDir, logger)
    const fileCheck = result.checks.find(c => c.name === 'raw_json_files')
    expect(fileCheck.ok).toBe(true)
  })
})

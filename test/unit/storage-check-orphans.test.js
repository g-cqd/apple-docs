import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../src/storage/database.js'
import { storageCheckOrphans } from '../../src/commands/storage.js'

let dataDir
let db

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-orphans-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('storageCheckOrphans', () => {
  test('returns zero counts on a fresh DB', () => {
    const result = storageCheckOrphans({}, { db })
    expect(result.fkViolations).toEqual([])
    expect(result.semanticOrphans.crawlStateMissingRoot).toBe(0)
    expect(result.semanticOrphans.refsMissingSourcePage).toBe(0)
    expect(result.semanticOrphans.documentsMissingPage).toBe(0)
  })

  test('detects crawl_state with missing root', () => {
    db.db.run(
      "INSERT INTO crawl_state (path, status, root_slug) VALUES ('foo', 'pending', 'nonexistent-root')",
    )
    const result = storageCheckOrphans({}, { db })
    expect(result.semanticOrphans.crawlStateMissingRoot).toBe(1)
  })

  test('detects PRAGMA foreign_key_check violations when bypassed', () => {
    // Bypass FKs to plant a violation: pages.root_id → roots.id has a real FK.
    db.db.run('PRAGMA foreign_keys = OFF')
    db.db.run(
      "INSERT INTO pages (root_id, path, url, status) VALUES (9999, 'orphan', 'https://example.test', 'active')",
    )
    db.db.run('PRAGMA foreign_keys = ON')

    const result = storageCheckOrphans({}, { db })
    expect(result.fkViolations.length).toBeGreaterThanOrEqual(1)
    expect(result.fkViolations.some((v) => v.table === 'pages')).toBe(true)
  })
})

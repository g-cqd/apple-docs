import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { consolidate } from '../../src/commands/consolidate.js'
import { createLogger } from '../../src/lib/logger.js'
import { RateLimiter } from '../../src/lib/rate-limiter.js'

let db
let dataDir
let logger
let ctx

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-doctor-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  logger = createLogger('error')
  const rateLimiter = new RateLimiter(100, 100)
  ctx = { db, dataDir, rateLimiter, logger }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('doctor --verify', () => {
  test('returns installed:false when no snapshot meta exists', async () => {
    const result = await consolidate({ verify: true, dryRun: true }, ctx)
    expect(result.snapshotVerification).not.toBeNull()
    expect(result.snapshotVerification.installed).toBe(false)
    expect(result.snapshotVerification.message).toContain('No snapshot')
  })

  test('passes all checks with valid snapshot meta', async () => {
    // Seed document
    db.upsertNormalizedDocument({
      document: {
        key: 'swiftui/view',
        title: 'View',
        sourceType: 'apple-docc',
        framework: 'swiftui',
        role: 'symbol',
      },
      sections: [],
      relationships: [],
    })

    // Set snapshot meta matching the corpus
    db.setSnapshotMeta('snapshot_tier', 'standard')
    db.setSnapshotMeta('snapshot_tag', 'test-v1')
    db.setSnapshotMeta('snapshot_schema_version', '7')
    db.setSnapshotMeta('snapshot_document_count', '1')
    db.setSnapshotMeta('snapshot_installed_at', '2026-04-13T00:00:00Z')

    const result = await consolidate({ verify: true, dryRun: true }, ctx)
    const sv = result.snapshotVerification
    expect(sv.installed).toBe(true)
    expect(sv.tier).toBe('standard')
    expect(sv.tag).toBe('test-v1')
    expect(sv.ok).toBe(true)
    expect(sv.checks.every(c => c.ok)).toBe(true)
  })

  test('detects document count mismatch', async () => {
    // Claim 100 documents but have none
    db.setSnapshotMeta('snapshot_tier', 'lite')
    db.setSnapshotMeta('snapshot_schema_version', '7')
    db.setSnapshotMeta('snapshot_document_count', '100')

    const result = await consolidate({ verify: true, dryRun: true }, ctx)
    const sv = result.snapshotVerification
    expect(sv.installed).toBe(true)
    expect(sv.ok).toBe(false)

    const countCheck = sv.checks.find(c => c.name === 'document_count')
    expect(countCheck.ok).toBe(false)
    expect(countCheck.expected).toBe(100)
    expect(countCheck.actual).toBe(0)
  })

  test('returns null verification when --verify not set', async () => {
    const result = await consolidate({ dryRun: true }, ctx)
    expect(result.snapshotVerification).toBeNull()
  })
})
